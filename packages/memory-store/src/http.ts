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
 *                                LLM synthesis). Each hit carries a
 *                                `signals` field with per-channel scores.
 *   POST /v1/distill          → DistillOutput (entity extraction from
 *                                a single raw message; requires
 *                                `unified.entityExtractor`)
 *   POST /v1/derive           → DeriveOutput (fact derivation over a
 *                                window of candidate texts; requires
 *                                `unified.deriver`)
 *   POST /v1/raw-messages     → upsert raw messages (returns count)
 *   GET  /v1/raw-messages/:id → single raw message
 *   POST /v1/consolidate:apply → ApplyConsolidateOutput (agentic write-back)
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
 * `POST /v1/consolidate:apply` runs the same evidence pipeline as
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
import { isFactType } from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import { closeSQLiteVsaStore, getSQLiteVsaStore } from "@melandlabs/sqlite";
import { Hono } from "hono";
import type { MemoryStoreConfig } from "./index";
import { type ApplyConsolidateInput, applyReflectedPlan } from "./search/apply-reflect";
import { type DeriveInput, deriveFacts } from "./search/derive";
import { type DistillInput, distillRawMessage } from "./search/distill";
import { createUnifiedSearch } from "./search/unified-search";
import type { SearchInput } from "./search/utilities";
import { type VsaRecallFacade, createVsaRecall } from "./search/vsa";
import { type RawMessageIngestManager, persistRawMessages } from "./storage/raw-message-ingest";
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
	storeMessagesWithSearchChunks?: RawMessageIngestManager["storeMessagesWithSearchChunks"];
	getMessageById?: RawMessageGetFn;
	upsertVectorForMessage?(messageId: string, embedding: number[] | undefined): void;
	lexicalSearchMessages?(input: {
		userId: string;
		keywords: string[];
		limit?: number;
		botId?: string;
	}): Promise<unknown[]>;
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

	app.get("/health", async (c) => {
		const retrieval = options.unified?.getRawMessageRetrievalStatus
			? await options.unified.getRawMessageRetrievalStatus().catch(() => ({
					backend: "unknown",
					childCount: 0,
					embeddedChildCount: 0,
					indexedDimensions: [],
					semanticReady: false,
					lexicalReady: false,
					semanticDegradedReason: "health_check_failed",
				}))
			: undefined;
		return c.json({ ok: true, store: "memory", ts: Date.now(), retrieval });
	});

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
				? ((body.synthesize as { responseSchema?: Record<string, unknown> }).responseSchema ??
					(body.responseSchema as Record<string, unknown> | undefined))
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
			documentIds: Array.isArray(body.documentIds) ? (body.documentIds as string[]) : undefined,
			includeArchivedInsights: body.includeArchivedInsights === true,
			authToken: typeof body.authToken === "string" ? body.authToken : undefined,
			dateFrom: typeof body.dateFrom === "string" ? body.dateFrom : undefined,
			dateTo: typeof body.dateTo === "string" ? body.dateTo : undefined,
			reasoningStrategy:
				body.reasoningStrategy === "rewrite" ||
				body.reasoningStrategy === "iterative" ||
				body.reasoningStrategy === "union"
					? body.reasoningStrategy
					: undefined,
			mergeStrategy:
				body.mergeStrategy === "rrf" || body.mergeStrategy === "similarity" ? body.mergeStrategy : undefined,
			includeRetrievalDiagnostics: body.includeRetrievalDiagnostics === true,
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

	app.post("/v1/distill", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const messageId = typeof body.messageId === "string" ? body.messageId : null;
		const content = typeof body.content === "string" ? body.content : null;
		if (!userId || !messageId || content === null || content.length === 0) {
			return c.json({ error: "userId, messageId, and a non-empty content are required" }, 400);
		}
		const input: DistillInput = { userId, messageId, content };
		try {
			const result = await distillRawMessage(options.unified ?? {}, input, console);
			return c.json(result);
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side error log — needed for ops triage
			console.error("[memory-store/http] distill failed:", error);
			return c.json({ error: (error as Error).message ?? "distill failed" }, 500);
		}
	});

	app.post("/v1/derive", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		if (!userId) {
			return c.json({ error: "userId is required" }, 400);
		}
		const windowFrom = typeof body.windowFrom === "number" ? body.windowFrom : undefined;
		const windowTo = typeof body.windowTo === "number" ? body.windowTo : undefined;
		const window =
			windowFrom !== undefined && windowTo !== undefined ? { from: windowFrom, to: windowTo } : undefined;
		// Validate peers minimally — accept `[{kind, id}]` shape with
		// `kind ∈ {"user","agent"}` and a non-empty `id`. Drop invalid
		// entries silently rather than failing the whole request.
		const peers = Array.isArray(body.peers)
			? (body.peers as Array<Record<string, unknown>>).filter(
					(p): p is { kind: "user" | "agent"; id: string } =>
						(p?.kind === "user" || p?.kind === "agent") && typeof p?.id === "string" && p.id.length > 0,
				)
			: undefined;
		const factTypes = Array.isArray(body.factTypes)
			? (body.factTypes as unknown[]).filter(isFactType)
			: undefined;
		const input: DeriveInput = {
			userId,
			...(typeof body.query === "string" ? { query: body.query } : {}),
			botIds: Array.isArray(body.botIds) ? (body.botIds as string[]) : undefined,
			dateFrom: typeof body.dateFrom === "string" ? body.dateFrom : undefined,
			dateTo: typeof body.dateTo === "string" ? body.dateTo : undefined,
			...(window ? { window } : {}),
			...(Array.isArray(body.candidateTexts) ? { candidateTexts: body.candidateTexts as string[] } : {}),
			...(typeof body.candidateLimit === "number" ? { candidateLimit: body.candidateLimit } : {}),
			...(peers && peers.length > 0 ? { peers } : {}),
			...(factTypes && factTypes.length > 0 ? { factTypes } : {}),
		};
		try {
			const result = await deriveFacts(options.unified ?? {}, input, console);
			return c.json(result);
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side error log — needed for ops triage
			console.error("[memory-store/http] derive failed:", error);
			return c.json({ error: (error as Error).message ?? "derive failed" }, 500);
		}
	});

	app.post("/v1/consolidate:apply", async (c) => {
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
		const input: ApplyConsolidateInput = {
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
		const incoming = (body.messages as RawMessage[]).map((m) => ({
			...m,
			userId: m.userId ?? body.userId,
		}));

		const persisted = await persistRawMessages({
			manager,
			userId: body.userId,
			messages: incoming,
			embedOnInsert: body.embedOnInsert,
			unified: options.unified,
			externalIndex: options.unified?.rawMessageChildIndex,
		});
		const result = persisted.ids
			? { inserted: persisted.ids.length, ids: persisted.ids }
			: { inserted: persisted.count };

		return c.json({
			ok: true,
			count: persisted.count,
			result,
			...(persisted.warnings.length > 0 ? { warnings: persisted.warnings } : {}),
		});
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
			return c.json({ error: "userId, roleLabel, and fillerLabel are required" }, 400);
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
			return c.json({ error: (error as Error).message ?? "vsa.store failed" }, 400);
		}
	});

	app.post("/v1/vsa/recall", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const userId = typeof body.userId === "string" ? body.userId : null;
		const roleLabel = typeof body.roleLabel === "string" ? body.roleLabel : null;
		const roleVector = Array.isArray(body.roleVector) ? (body.roleVector as number[]) : null;
		const vocabulary = Array.isArray(body.vocabulary) ? body.vocabulary : null;
		if (!userId || !roleLabel || !roleVector || !vocabulary) {
			return c.json({ error: "userId, roleLabel, roleVector[], and vocabulary[] are required" }, 400);
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
			return c.json({ error: (error as Error).message ?? "vsa.recall failed" }, 400);
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
			return c.json({ error: (error as Error).message ?? "vsa.list failed" }, 400);
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
			return c.json({ error: (error as Error).message ?? "vsa.forget failed" }, 400);
		}
	});

	// OKF v0.2 importer / exporter routes. They reuse the same Hono app
	// so a host running `opencontext http` exposes `/v1/okf/import` and
	// `/v1/okf/export` without extra wiring. Failures inside the OKF
	// codec (missing fields, schema drift, store conflict) are surfaced
	// via the same `issues[]` envelope the CLI uses.
	//
	// `@melandlabs/okf/http` is loaded lazily (and through a non-literal
	// string specifier so TypeScript can't resolve its types at
	// compile time) because memory-store and OKF form a workspace
	// cycle: memory-store → okf via `dependencies`, okf → memory-store
	// via `devDependencies`. A static import of `registerOkfRoutes`
	// here would force `dist/http.d.ts` to exist for OKF before
	// memory-store can emit its own `dist/http.d.ts`, and OKF's DTS
	// step in turn needs memory-store's `dist/index.d.ts`. Loading
	// through `await import(okfHttpSpecifier)` keeps the runtime
	// contract identical (OKF ships alongside memory-store as a
	// regular `dependency`, so the dynamic import resolves at startup
	// in any environment that already has the OKF package installed)
	// while letting pnpm 10 build memory-store first in topological
	// order without a type-level cycle.
	const okfHttpSpecifier: string = "@melandlabs/okf/http";
	const { registerOkfRoutes } = await import(okfHttpSpecifier);
	registerOkfRoutes(app, rawStore, {
		writeMessages: async (userId: string, messages: RawMessage[]) => {
			await persistRawMessages({
				manager,
				userId,
				messages,
				unified: options.unified,
				externalIndex: options.unified?.rawMessageChildIndex,
			});
		},
	});

	const server = serve({ fetch: app.fetch, port, hostname: host });

	return {
		url: `http://${host}:${port}`,
		port,
		async stop() {
			// Order matters: close the HTTP server first and wait for it to
			// drain in-flight handlers, THEN close the stores. Closing the
			// stores while handlers are still calling into rawStore races
			// sqlite-vec's TLS mutex destructors against active queries and
			// surfaces the dreaded
			//     libc++abi: ... mutex lock failed: Invalid argument
			// on SIGTERM.
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rawStore.close();
			await closeSQLiteVsaStore();
		},
	};
}

export type { MemoryStoreConfig };
