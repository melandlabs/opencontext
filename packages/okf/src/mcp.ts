/**
 * `@melandlabs/okf/mcp` — MCP tools for the OKF v0.2 importer / exporter.
 *
 * Two tools, mirroring the HTTP surface:
 *
 *   memory.okfImport  { userId, botId?, platform?, document }
 *   memory.okfExport  { userId, botId?, platform?, since?, until?, types?, includeArchived? }
 *
 * `rawStore` is the same `createRawMessageStore({})` value the memory-store
 * MCP server uses; the okf package owns its tools so the memory-store
 * doesn't need to know about `@melandlabs/okf`.
 */

import type { OkfDocument } from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ZodRawShape, z } from "zod";
import { filterRawMessagesByOkfType, isBlockingOkfIssue, okfToRawMessage, rawMessageToOkf } from "./codec.js";

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

export function registerOkfTools(
	server: McpServer,
	rawStore: RawMessageStoreLike,
	options: { writeMessages?: (userId: string, messages: RawMessage[]) => Promise<void> } = {},
): void {
	const importSchema: ZodRawShape = {
		userId: z.string(),
		botId: z.string().optional(),
		platform: z.string().optional(),
		document: z
			.object({
				resource: z.string().optional(),
				frontMatter: z.record(z.string(), z.unknown()),
				body: z.string(),
			})
			.passthrough(),
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.okfImport",
		{
			title: "Import OKF Document",
			description:
				"Convert an OKF v0.2 document (YAML front-matter + Markdown body) into a RawMessage and persist it under the given userId. Returns the new messageId and factType on success, or an `issues[]` array on validation failure.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod 4 schemas via `any`.
			inputSchema: importSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				botId?: string;
				platform?: string;
				document: OkfDocument;
			};
			try {
				const codec = okfToRawMessage(
					{ frontMatter: a.document.frontMatter, body: a.document.body },
					{
						userId: a.userId,
						botId: a.botId,
						platform: a.platform,
					},
				);
				const blocking = codec.issues.filter(isBlockingOkfIssue);
				if (blocking.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ ok: false, issues: codec.issues }),
							},
						],
						isError: true,
					};
				}
				const manager = await rawStore.getManager();
				try {
					if (options.writeMessages) {
						await options.writeMessages(a.userId, [codec.rawMessage]);
					} else if (typeof manager.upsertRawMessages === "function") {
						await manager.upsertRawMessages({ userId: a.userId, messages: [codec.rawMessage] });
					} else if (typeof manager.storeMessages === "function") {
						await manager.storeMessages([codec.rawMessage]);
					} else {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										error: "active raw-message manager exposes neither upsertRawMessages nor storeMessages",
									}),
								},
							],
							isError: true,
						};
					}
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: err instanceof Error ? err.message : String(err),
									code: "store_error",
									issues: codec.issues,
								}),
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								ok: true,
								messageId: codec.messageId,
								factType: codec.rawMessage.factType,
								issues: codec.issues.length > 0 ? codec.issues : undefined,
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	const exportSchema: ZodRawShape = {
		userId: z.string(),
		botId: z.string().optional(),
		platform: z.string().optional(),
		since: z.string().optional(),
		until: z.string().optional(),
		types: z.array(z.string()).optional(),
		includeArchived: z.boolean().optional(),
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.okfExport",
		{
			title: "Export OKF Documents",
			description:
				"Query the user's RawMessage records and return them as OKF v0.2 documents (frontMatter + body). Optional filters: botId, platform, since/until (ISO 8601 or epoch ms), okf types, includeArchived.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod 4 schemas via `any`.
			inputSchema: exportSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				botId?: string;
				platform?: string;
				since?: string;
				until?: string;
				types?: string[];
				includeArchived?: boolean;
			};
			try {
				const query: Record<string, unknown> = {
					userId: a.userId,
					limit: 100_000,
					includeArchived: a.includeArchived === true,
					...(a.botId ? { botId: a.botId } : {}),
					...(a.platform ? { platform: a.platform } : {}),
				};
				if (a.since) query.startTime = parseTime(a.since, "since");
				if (a.until) query.endTime = parseTime(a.until, "until");
				const manager = await rawStore.getManager();
				let rows: RawMessage[] = [];
				if (typeof manager.queryMessages === "function") {
					rows = (await manager.queryMessages(query)) as RawMessage[];
				} else if (typeof manager.queryMessagesGrouped === "function") {
					const grouped = (await manager.queryMessagesGrouped(query)) as Record<string, RawMessage[]>;
					rows = Object.values(grouped).flat();
				}
				// Shared helper: matches explicit `metadata.okfType`, falling
				// back to the factType→OKF inverse map for older records, so
				// MCP export behaves identically to CLI / HTTP.
				const filtered = filterRawMessagesByOkfType(rows, a.types ?? null);
				const documents: OkfDocument[] = filtered.map((r) => rawMessageToOkf(r).document);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ ok: true, count: documents.length, documents }),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
						},
					],
					isError: true,
				};
			}
		},
	);
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
