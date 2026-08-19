/**
 * `@melandlabs/okf/http` — Hono routes for the OKF v0.2 importer / exporter.
 *
 * Three POST routes:
 *
 *   POST /v1/okf/import
 *     body: { userId, botId?, platform?, document: { resource?, frontMatter, body } }
 *     → 200 { ok, messageId, factType, indexed }
 *     → 400 { error, issues? }
 *
 *   POST /v1/okf/import-batch
 *     body: { userId, botId?, platform?, documents: [...] }
 *     → 200 { ok, count, results: [{ ok, messageId?, issues? }] }
 *
 *   POST /v1/okf/export
 *     body: { userId, botId?, platform?, since?, until?, types?, includeArchived? }
 *     → 200 { ok, count, documents: [...] }
 *
 * The `rawStore` argument is the same `createRawMessageStore({})` value
 * the memory-store HTTP server uses; the okf package owns its routes
 * so the memory-store doesn't need to know about `@melandlabs/okf`.
 */

import { Hono } from "hono";
import type { OkfDocument } from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import {
	okfToRawMessage,
	rawMessageToOkf,
	isBlockingOkfIssue,
	filterRawMessagesByOkfType,
} from "./codec.js";

interface RawMessageStoreLike {
	getManager(): Promise<RawMessageManagerLike>;
	close(): Promise<void>;
}

interface RawMessageManagerLike {
	upsertRawMessages?: (input: { userId: string; messages: RawMessage[] }) => Promise<unknown>;
	storeMessages?: (messages: RawMessage[]) => Promise<number[]>;
	queryMessages?: (input: Record<string, unknown>) => Promise<RawMessage[]>;
	queryMessagesGrouped?: (input: Record<string, unknown>) => Promise<Record<string, RawMessage[]>>;
}

/**
 * Register the OKF routes onto a Hono app. The owning server is
 * responsible for `app.listen()`; this function only adds the three
 * POST handlers.
 */
export function registerOkfRoutes(app: Hono, rawStore: RawMessageStoreLike): void {
	app.post("/v1/okf/import", async (c) => {
		const body = await readJson(c);
		if (!body) return c.json({ error: "invalid JSON body" }, 400);
		const userId = stringOrNull(body.userId);
		const document = parseOkfDocumentInput(body.document);
		if (!userId) return c.json({ error: "userId is required" }, 400);
		if (!document) return c.json({ error: "document { frontMatter, body } is required" }, 400);

		const codec = okfToRawMessage(
			{ frontMatter: document.frontMatter, body: document.body },
			{
				userId,
				botId: stringOrNull(body.botId) ?? undefined,
				platform: stringOrNull(body.platform) ?? undefined,
			},
		);
		if (codec.issues.some(isBlockingOkfIssue)) {
			return c.json({ error: "validation failed", issues: codec.issues }, 400);
		}
		const manager = await rawStore.getManager();
		const messages = [codec.rawMessage];
		try {
			if (typeof manager.upsertRawMessages === "function") {
				await manager.upsertRawMessages({ userId, messages });
			} else if (typeof manager.storeMessages === "function") {
				await manager.storeMessages(messages);
			} else {
				return c.json(
					{ error: "active raw-message manager exposes neither upsertRawMessages nor storeMessages" },
					500,
				);
			}
		} catch (err) {
			// The store throws (e.g. cross-user messageId conflict). Surface
			// a 409 so the caller can distinguish a hard store error from
			// the 400 / 500 above rather than letting Hono return a bare
			// 500 with the stack trace.
			return c.json(
				{
					error: err instanceof Error ? err.message : String(err),
					code: "store_error",
					issues: codec.issues,
				},
				409,
			);
		}
		return c.json({
			ok: true,
			messageId: codec.messageId,
			factType: codec.rawMessage.factType,
			indexed: true,
			issues: codec.issues.length > 0 ? codec.issues : undefined,
		});
	});

	app.post("/v1/okf/import-batch", async (c) => {
		const body = await readJson(c);
		if (!body) return c.json({ error: "invalid JSON body" }, 400);
		const userId = stringOrNull(body.userId);
		if (!userId) return c.json({ error: "userId is required" }, 400);
		const documents = Array.isArray(body.documents) ? (body.documents as unknown[]) : null;
		if (!documents) return c.json({ error: "documents[] is required" }, 400);

		const manager = await rawStore.getManager();
		// Seed the dedup set with ids already in the store so re-ingesting a
		// package that collides with existing slugs appends `-2`/`‑3` instead
		// of overwriting a canonical record.
		const existingIds = new Set<string>();
		{
			let existing: RawMessage[] = [];
			if (typeof manager.queryMessages === "function") {
				existing = (await manager.queryMessages({ userId, limit: 100_000 })) as RawMessage[];
			} else if (typeof manager.queryMessagesGrouped === "function") {
				const grouped = (await manager.queryMessagesGrouped({ userId, limit: 100_000 })) as Record<
					string,
					RawMessage[]
				>;
				existing = Object.values(grouped).flat();
			}
			for (const r of existing) if (r.messageId) existingIds.add(r.messageId);
		}
		const results: Array<{ ok: boolean; messageId?: string; issues?: unknown }> = [];
		const messages: RawMessage[] = [];
		for (const raw of documents) {
			const document = parseOkfDocumentInput(raw);
			if (!document) {
				results.push({
					ok: false,
					issues: [{ code: "invalid_frontmatter", message: "missing frontMatter / body" }],
				});
				continue;
			}
			try {
				const codec = okfToRawMessage(
					{ frontMatter: document.frontMatter, body: document.body },
					{
						userId,
						botId: stringOrNull(body.botId) ?? undefined,
						platform: stringOrNull(body.platform) ?? undefined,
						existingIds,
					},
				);
				// Reject the same blocking issues as the single-import path so a
				// missing `type` / `generated.at` / empty body can't slip into
				// the store via batch.
				if (codec.issues.some(isBlockingOkfIssue)) {
					results.push({ ok: false, issues: codec.issues });
					continue;
				}
				messages.push(codec.rawMessage);
				existingIds.add(codec.messageId);
				results.push({
					ok: true,
					messageId: codec.messageId,
					...(codec.issues.length > 0 ? { issues: codec.issues } : {}),
				});
			} catch (err) {
				results.push({
					ok: false,
					issues: [
						{ code: "invalid_frontmatter", message: err instanceof Error ? err.message : String(err) },
					],
				});
			}
		}
		if (messages.length > 0) {
			try {
				if (typeof manager.upsertRawMessages === "function") {
					await manager.upsertRawMessages({ userId, messages });
				} else if (typeof manager.storeMessages === "function") {
					await manager.storeMessages(messages);
				}
			} catch (err) {
				return c.json(
					{ error: err instanceof Error ? err.message : String(err), code: "store_error", results },
					409,
				);
			}
		}
		return c.json({ ok: true, count: messages.length, results });
	});

	app.post("/v1/okf/export", async (c) => {
		const body = await readJson(c);
		if (!body) return c.json({ error: "invalid JSON body" }, 400);
		const userId = stringOrNull(body.userId);
		if (!userId) return c.json({ error: "userId is required" }, 400);

		const query: Record<string, unknown> = {
			userId,
			limit: 100_000,
			includeArchived: body.includeArchived === true,
			...(stringOrNull(body.botId) ? { botId: body.botId } : {}),
			...(stringOrNull(body.platform) ? { platform: body.platform } : {}),
		};
		if (typeof body.since === "string") {
			query.startTime = parseTime(body.since, "since");
		}
		if (typeof body.until === "string") {
			query.endTime = parseTime(body.until, "until");
		}
		const manager = await rawStore.getManager();
		let rows: RawMessage[] = [];
		if (typeof manager.queryMessages === "function") {
			rows = (await manager.queryMessages(query)) as RawMessage[];
		} else if (typeof manager.queryMessagesGrouped === "function") {
			const grouped = (await manager.queryMessagesGrouped(query)) as Record<string, RawMessage[]>;
			rows = Object.values(grouped).flat();
		}
		const types = Array.isArray(body.types) ? (body.types as string[]) : null;
		// Shared helper: filters by explicit `metadata.okfType`, falling back
		// to the factType→OKF inverse map for records that predate that
		// field. Keeps HTTP export identical to CLI / MCP.
		const filtered = filterRawMessagesByOkfType(rows, types);
		const documents: OkfDocument[] = filtered.map((r) => rawMessageToOkf(r).document);
		return c.json({ ok: true, count: documents.length, documents });
	});
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<
	string,
	unknown
> | null> {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseOkfDocumentInput(raw: unknown): OkfDocument | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const frontMatter =
		obj.frontMatter && typeof obj.frontMatter === "object" && !Array.isArray(obj.frontMatter)
			? (obj.frontMatter as OkfDocument["frontMatter"])
			: null;
	const body = typeof obj.body === "string" ? obj.body : null;
	if (!frontMatter || body === null) return null;
	return {
		frontMatter,
		body,
		...(stringOrNull(obj.resource) ? { resource: obj.resource as string } : {}),
	};
}

function parseTime(value: string, flag: string): number {
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	const ms = Date.parse(trimmed);
	if (Number.isNaN(ms)) {
		throw new Error(`invalid ${flag}: ${value} (expected ISO 8601 or epoch ms)`);
	}
	return ms;
}
