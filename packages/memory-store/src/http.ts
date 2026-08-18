/**
 * @melandlabs/memory-store/http — HTTP server entry.
 *
 * Usage:
 *   import { startHttpServer } from "@melandlabs/memory-store/http";
 *   const { url, stop } = await startHttpServer({
 *     port: 7421,
 *     db: { getDb: () => drizzleDb() },
 *   });
 *
 * Endpoints (all POST, JSON in/out):
 *   GET  /health              → { ok: true }
 *   POST /v1/search           → SearchOutput (set `synthesize: true` for
 *                                LLM synthesis)
 *   POST /v1/raw-messages     → upsert raw messages (returns count)
 *   GET  /v1/raw-messages/:id → single raw message
 *   POST /v1/reflect:apply    → ApplyReflectOutput (agentic write-back)
 *   POST /v1/vsa/store        → StoreVsaFactOutput
 *   POST /v1/vsa/recall       → VsaRecallOutput
 *   POST /v1/vsa/list         → VsaFactSummary[]
 *   POST /v1/vsa/forget       → VsaForgetOutput
 *
 * `POST /v1/raw-messages` supports two body keys beyond `userId` /
 * `messages[]`:
 *
 *   - `embedOnInsert: true` — when set AND `unified.embedQuery` is wired
 *      (i.e. the host passed `--embedding-provider local|openrouter` or
 *      supplied its own embedder), the server fills in any message
 *      whose `embedding` field is missing by calling `embedQuery`
 *      against `message.content` server-side. This is what makes the
 *      daemon usable end-to-end with `--memory-backend=sqlite-vec` and
 *      bare curl POSTs — without this flag, the bin logs the warning
 *      and the messages persist without an embedding (so ANN search
 *      won't return them).
 *
 * `POST /v1/reflect:apply` runs the same evidence pipeline as
 * `POST /v1/search` with `synthesize: true`, then builds a
 * memory-consolidation plan, optionally asks the LLM to veto unsafe
 * entries, and persists via the attached graph store (when the host
 * wired one into `options.graphStore`) + soft-deprecates superseded
 * records via the storage adapter.
 *
 * The HTTP server speaks only to the raw-message + vector layers; it does
 * not expose RAG/insights cross-source search (callers wire those up
 * server-side or use the MCP server with a fully-wired store).
 */

import { serve } from "@hono/node-server";
import type { RawMessage } from "@melandlabs/indexeddb";
import { Hono } from "hono";
import { closeSQLiteVsaStore, getSQLiteVsaStore } from "@melandlabs/sqlite";
import type { UnifiedSearchDeps } from "./config";
import type { MemoryStoreConfig } from "./index";
import { type ApplyReflectInput, applyReflectedPlan } from "./search/apply-reflect";
import { createUnifiedSearch } from "./search/unified-search";
import type { SearchInput } from "./search/utilities";
import { createVsaRecall, type VsaRecallFacade } from "./search/vsa";
import { upsertRawMessagesToChroma } from "./storage/chroma-memory-index";
import { createRawMessageStore } from "./storage/raw-message-store";
import { resolveSQLiteRawMessageDbPath } from "./storage/sqlite-raw-message-store";

export interface StartHttpServerOptions extends MemoryStoreConfig {
	/** Port to bind. Defaults to 7421. */
	port?: number;
	/** Bind address. Defaults to 127.0.0.1 (loopback only — change to 0.0.0.0 for LAN). */
	host?: string;
}

export interface StartedHttpServer {
	url: string;
	port: number;
	stop(): Promise<void>;
}

type RawMessageUpsertFn = (input: { userId: string; messages: RawMessage[] }) => Promise<unknown>;
type RawMessageStoreFn = (messages: RawMessage[]) => Promise<number[]>;
type RawMessageGetFn = (messageId: string) => Promise<RawMessage | null | undefined>;

interface RawMessageManagerLike {
	upsertRawMessages?: RawMessageUpsertFn;
	storeMessages?: RawMessageStoreFn;
	getMessageById?: RawMessageGetFn;
	upsertVectorForMessage?(messageId: string, embedding: number[] | undefined): void;
	lexicalSearchMessages?(input: {
		userId: string;
		keywords: string[];
		limit?: number;
		botId?: string;
	}): Promise<unknown[]>;
}

async function embedMissingMessages(messages: RawMessage[], deps: UnifiedSearchDeps): Promise<RawMessage[]> {
	if (typeof deps.embedQuery !== "function") {
		return messages;
	}
	const out: RawMessage[] = [];
	for (const message of messages) {
		if (Array.isArray(message.embedding) && message.embedding.length > 0) {
			out.push(message);
			continue;
		}
		if (typeof message.content !== "string" || message.content.length === 0) {
			out.push(message);
			continue;
		}
		const vector = await deps.embedQuery({
			userId: message.userId,
			query: message.content,
		});
		out.push({
			...message,
			embedding: vector,
			embeddingModel: message.embeddingModel ?? "server",
			embeddingDimensions: vector.length,
			embeddingUpdatedAt: Date.now(),
		});
	}
	return out;
}

export async function startHttpServer(options: StartHttpServerOptions = {}): Promise<StartedHttpServer> {
	const port = options.port ?? Number.parseInt(process.env.MEMORY_HTTP_PORT ?? "7421", 10);
	const host = options.host ?? process.env.MEMORY_HTTP_HOST ?? "127.0.0.1";

	const rawStore = createRawMessageStore({
		env: options.env,
	});

	// Configure lexical search for keyword fallback
	const manager = await rawStore.getManager();
	const search = createUnifiedSearch({
		...options.unified,
		searchRawMessagesLexical: async (input) => {
			if (typeof manager.lexicalSearchMessages === "function") {
				const results = await manager.lexicalSearchMessages(input);
				return (
					results as Array<{
						id: string;
						content: string;
						similarity: number;
						metadata: Record<string, unknown>;
					}>
				)
					.filter(Boolean)
					.map((r) => ({
						type: "memory" as const,
						id: r.id,
						content: r.content,
						similarity: r.similarity,
						metadata: r.metadata ?? {},
					}));
			}
			return [];
		},
	});

	// VSA facade — shares the SQLite DB with the raw-message store so the
	// `vsa_facts` table lives next to the rest of the user data. Hosts that
	// want a separate DB can construct `SQLiteVsaStore` themselves and call
	// `createVsaRecall` — but for the daemon / curl story we want VSA
	// available out of the box.
	const vsaDbPath = resolveSQLiteRawMessageDbPath(options.dbPath);
	const vsaStorage = await getSQLiteVsaStore({ dbPath: vsaDbPath });
	const vsa: VsaRecallFacade = createVsaRecall(vsaStorage);

	const app = new Hono();

	app.get("/health", (c) => c.json({ ok: true, store: "memory", ts: Date.now() }));

	app.post("/v1/search", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const query = typeof body.query === "string" ? body.query : "";
		if (!userId || !query) {
			return c.json({ error: "userId and query are required" }, 400);
		}
		const wantsSynthesis =
			typeof body.synthesize === "boolean"
				? body.synthesize
				: typeof body.synthesize === "object" && body.synthesize !== null;
		const responseSchema =
			typeof body.synthesize === "object" && body.synthesize !== null
				? (body.synthesize as { responseSchema?: Record<string, unknown> }).responseSchema ??
					(body.responseSchema as Record<string, unknown> | undefined)
				: (body.responseSchema as Record<string, unknown> | undefined);
		const input: SearchInput = {
			userId,
			query,
			sources: Array.isArray(body.sources)
				? (body.sources as Array<"memory" | "insights" | "knowledge">)
				: undefined,
			tiers: Array.isArray(body.tiers)
				? (body.tiers as Array<"summary" | "raw" | "insight" | "knowledge">)
				: undefined,
			limit: typeof body.limit === "number" ? body.limit : undefined,
			threshold: typeof body.threshold === "number" ? body.threshold : undefined,
			botIds: Array.isArray(body.botIds) ? (body.botIds as string[]) : undefined,
			documentIds: Array.isArray(body.documentIds)
				? (body.documentIds as string[])
				: undefined,
			includeArchivedInsights: body.includeArchivedInsights === true,
			authToken: typeof body.authToken === "string" ? body.authToken : undefined,
			dateFrom: typeof body.dateFrom === "string" ? body.dateFrom : undefined,
			dateTo: typeof body.dateTo === "string" ? body.dateTo : undefined,
			...(wantsSynthesis
				? {
						synthesize: {
							...(responseSchema ? { responseSchema } : {}),
						},
					}
				: {}),
		};
		const result = await search.search(input);
		return c.json(result);
	});

	app.post("/v1/reflect:apply", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const query = typeof body.query === "string" ? body.query : "";
		const ownerScope = (body.ownerScope ?? {}) as { userId?: string };
		if (!userId || !query) {
			return c.json({ error: "userId and query are required" }, 400);
		}
		if (typeof ownerScope.userId !== "string") {
			return c.json({ error: "ownerScope.userId is required" }, 400);
		}
		const input: ApplyReflectInput = {
			userId,
			query,
			ownerScope: { userId: ownerScope.userId },
			botIds: Array.isArray(body.botIds) ? (body.botIds as string[]) : undefined,
			dateFrom: typeof body.dateFrom === "string" ? body.dateFrom : undefined,
			dateTo: typeof body.dateTo === "string" ? body.dateTo : undefined,
			tiers: Array.isArray(body.tiers)
				? (body.tiers as Array<"summary" | "raw" | "insight" | "knowledge">)
				: undefined,
			limit: typeof body.limit === "number" ? body.limit : undefined,
			threshold: typeof body.threshold === "number" ? body.threshold : undefined,
			dryRun: body.dryRun === true,
			expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
			authToken: typeof body.authToken === "string" ? body.authToken : undefined,
			llmPlanReview:
				body.llmPlanReview && typeof body.llmPlanReview === "object"
					? {
							maxTokens:
								typeof (body.llmPlanReview as { maxTokens?: unknown }).maxTokens === "number"
									? (body.llmPlanReview as { maxTokens: number }).maxTokens
									: undefined,
						}
					: undefined,
		};
		const result = await applyReflectedPlan(
			{ ...(options.unified ?? {}) },
			{ graphStore: options.graphStore, storage: options.storage },
			input,
			console,
		);
		return c.json(result);
	});

	app.post("/v1/raw-messages", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		if (!Array.isArray(body.messages) || !body.userId) {
			return c.json({ error: "userId and messages[] required" }, 400);
		}
		const manager = (await rawStore.getManager()) as RawMessageManagerLike;
		const incoming = body.messages as RawMessage[];

		// ── 1. Auto-embed messages that lack an embedding — but only when
		//      the client explicitly opted in via `embedOnInsert: true`
		//      AND an embedder is wired into `unified.*`. We deliberately
		//      don't auto-embed without the opt-in: hosts that send
		//      pre-embedded rows from a sidecar shouldn't pay the cost of
		//      a server-side inference call per message.
		const messages =
			body.embedOnInsert === true
				? await embedMissingMessages(
						incoming.map((m) => ({ ...m, userId: m.userId ?? body.userId })),
						options.unified ?? {},
					)
				: incoming.map((m) => ({ ...m, userId: m.userId ?? body.userId }));

		// ── 2. Insert into the active backend. Host-supplied Postgres
		//      factories take precedence (their `upsertRawMessages` is a
		//      richer upsert); the default SQLite manager falls through
		//      to `storeMessages`, which is an idempotent INSERT … ON
		//      CONFLICT(message_id) DO UPDATE.
		let result: unknown;
		if (typeof manager.upsertRawMessages === "function") {
			result = await manager.upsertRawMessages({
				userId: body.userId,
				messages,
			});
		} else if (typeof manager.storeMessages === "function") {
			const ids = await manager.storeMessages(messages);
			result = { inserted: ids.length, ids };
		} else {
			return c.json(
				{
					error: "active raw-message manager exposes neither upsertRawMessages nor storeMessages",
				},
				500,
			);
		}

		// ── 3. Parallel chroma upsert, best-effort. The legacy
		//      `isRawMessageChromaEnabled()` env path still applies.
		try {
			await upsertRawMessagesToChroma(messages as never);
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
			console.warn("[memory-store/http] chroma upsert failed:", error);
		}

		// ── 4. sqlite-vec vector table update (for messages with embeddings)
		try {
			const messagesWithEmbeddings = messages.filter(
				(m) => Array.isArray(m.embedding) && m.embedding.length > 0,
			);
			if (messagesWithEmbeddings.length > 0) {
				for (const message of messagesWithEmbeddings) {
					if (typeof manager.upsertVectorForMessage === "function") {
						manager.upsertVectorForMessage(message.messageId, message.embedding);
					}
				}
				// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
				console.log(
					"[memory-store/http] Updated sqlite-vec vector table for",
					messagesWithEmbeddings.length,
					"message(s)",
				);
			}
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
			console.warn("[memory-store/http] sqlite-vec vector update failed:", error);
		}

		return c.json({ ok: true, count: messages.length, result });
	});

	app.get("/v1/raw-messages/:id", async (c) => {
		const id = c.req.param("id");
		const userId = c.req.query("userId");
		if (!userId) return c.json({ error: "userId query param required" }, 400);
		const manager = (await rawStore.getManager()) as RawMessageManagerLike;
		const row = await manager.getMessageById?.(id);
		if (!row) return c.json({ error: "not found" }, 404);
		return c.json({ message: row });
	});

	app.post("/v1/vsa/store", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const roleLabel = typeof body.roleLabel === "string" ? body.roleLabel : null;
		const fillerLabel = typeof body.fillerLabel === "string" ? body.fillerLabel : null;
		if (!userId || !roleLabel || !fillerLabel) {
			return c.json(
				{ error: "userId, roleLabel, and fillerLabel are required" },
				400,
			);
		}
		if (!Array.isArray(body.roleVector) || !Array.isArray(body.fillerVector)) {
			return c.json({ error: "roleVector[] and fillerVector[] are required" }, 400);
		}
		try {
			const result = await vsa.storeFact({
				userId,
				roleLabel,
				fillerLabel,
				roleVector: body.roleVector as number[],
				fillerVector: body.fillerVector as number[],
				scopeTag: typeof body.scopeTag === "string" ? body.scopeTag : undefined,
				botId: typeof body.botId === "string" ? body.botId : undefined,
				factId: typeof body.factId === "string" ? body.factId : undefined,
			});
			return c.json(result);
		} catch (error) {
			return c.json(
				{ error: (error as Error).message ?? "vsa.store failed" },
				400,
			);
		}
	});

	app.post("/v1/vsa/recall", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const roleLabel = typeof body.roleLabel === "string" ? body.roleLabel : null;
		const roleVector = Array.isArray(body.roleVector) ? (body.roleVector as number[]) : null;
		const vocabulary = Array.isArray(body.vocabulary) ? body.vocabulary : null;
		if (!userId || !roleLabel || !roleVector || !vocabulary) {
			return c.json(
				{ error: "userId, roleLabel, roleVector[], and vocabulary[] are required" },
				400,
			);
		}
		try {
			const result = await vsa.recall({
				userId,
				roleLabel,
				roleVector,
				vocabulary: vocabulary as Array<{ label: string; vector: number[] }>,
				scopeTag: typeof body.scopeTag === "string" ? body.scopeTag : undefined,
				botId: typeof body.botId === "string" ? body.botId : undefined,
				maxFacts: typeof body.maxFacts === "number" ? body.maxFacts : undefined,
			});
			return c.json(result);
		} catch (error) {
			return c.json(
				{ error: (error as Error).message ?? "vsa.recall failed" },
				400,
			);
		}
	});

	app.post("/v1/vsa/list", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		if (!userId) return c.json({ error: "userId is required" }, 400);
		try {
			const facts = await vsa.listFacts({
				userId,
				scopeTag: typeof body.scopeTag === "string" ? body.scopeTag : undefined,
				botId: typeof body.botId === "string" ? body.botId : undefined,
				includeDeprecated: body.includeDeprecated === true,
			});
			return c.json({ facts });
		} catch (error) {
			return c.json(
				{ error: (error as Error).message ?? "vsa.list failed" },
				400,
			);
		}
	});

	app.post("/v1/vsa/forget", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const factIds = Array.isArray(body.factIds) ? (body.factIds as string[]) : null;
		if (!userId || !factIds) {
			return c.json({ error: "userId and factIds[] are required" }, 400);
		}
		try {
			const result = await vsa.forget({
				userId,
				factIds,
				reason: typeof body.reason === "string" ? body.reason : undefined,
			});
			return c.json(result);
		} catch (error) {
			return c.json(
				{ error: (error as Error).message ?? "vsa.forget failed" },
				400,
			);
		}
	});

	const server = serve({ fetch: app.fetch, port, hostname: host });

	return {
		url: `http://${host}:${port}`,
		port,
		async stop() {
			await rawStore.close();
			await closeSQLiteVsaStore();
			server.close();
		},
	};
}

export type { MemoryStoreConfig };
