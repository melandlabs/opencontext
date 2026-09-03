/**
 * @melandlabs/memory-store/mcp — MCP server entry.
 *
 * Spawns an MCP server (stdio transport by default) that exposes the
 * memory-store as tools any MCP client (Claude Code, etc.) can invoke.
 *
 * Tools registered:
 *   - memory.search            → SearchOutput (read-only; set
 *                                `synthesize: true` for LLM synthesis).
 *                                Each hit carries a `signals` field with
 *                                per-channel scores.
 *   - memory.distill           → DistillOutput (entity extraction from
 *                                a single raw message; requires
 *                                `unified.entityExtractor`)
 *   - memory.derive            → DeriveOutput (fact derivation over a
 *                                window of candidate texts; requires
 *                                `unified.deriver`)
 *   - memory.writeRawMessage   → { ok: boolean }
 *   - memory.getRawMessage     → RawMessage | null
 *   - memory.consolidate       → ApplyConsolidateOutput (agentic write-back)
 *   - memory.vsaStore          → StoreVsaFactOutput
 *   - memory.vsaRecall         → VsaRecallOutput
 *   - memory.vsaList           → VsaFactSummary[]
 *   - memory.vsaForget         → VsaForgetOutput
 *   - memory.health            → { ok: true }
 *
 * Usage:
 *   import { startMcpServer } from "@melandlabs/memory-store/mcp";
 *   await startMcpServer({ db: { getDb } });
 */

import { isFactType } from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import { closeSQLiteVsaStore, getSQLiteVsaStore } from "@melandlabs/sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ZodRawShape } from "zod";
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

export interface StartMcpServerOptions extends MemoryStoreConfig {
	/** Server name surfaced to the MCP client. */
	name?: string;
	/** Server version surfaced to the MCP client. */
	version?: string;
}

const DEFAULT_NAME = "@melandlabs/memory-store";
const DEFAULT_VERSION = "0.1.0";

type RawMessageStoreFn = (messages: RawMessage[]) => Promise<number[]>;
type RawMessageGetFn = (messageId: string) => Promise<RawMessage | null | undefined>;

interface RawMessageManagerLike {
	upsertRawMessages?: (input: { userId: string; messages: RawMessage[] }) => Promise<unknown>;
	storeMessages?: RawMessageStoreFn;
	storeMessagesWithSearchChunks?: RawMessageIngestManager["storeMessagesWithSearchChunks"];
	getMessageById?: RawMessageGetFn;
	lexicalSearchMessages?(input: {
		userId: string;
		keywords: string[];
		limit?: number;
		botId?: string;
	}): Promise<unknown[]>;
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<McpServer> {
	const server = new McpServer({
		name: options.name ?? DEFAULT_NAME,
		version: options.version ?? DEFAULT_VERSION,
	});

	const rawStore = createRawMessageStore({
		env: options.env,
	});
	const rawMessageManager = (await rawStore.getManager()) as RawMessageManagerLike;
	const search = createUnifiedSearch({
		...options.unified,
		searchRawMessagesLexical: async (input) => {
			if (typeof rawMessageManager.lexicalSearchMessages !== "function") return [];
			const results = (await rawMessageManager.lexicalSearchMessages(input)) as Array<{
				id: string;
				content: string;
				similarity: number;
				metadata?: Record<string, unknown>;
			}>;
			return results.filter(Boolean).map((result) => ({
				id: result.id,
				content: result.content,
				similarity: result.similarity,
				metadata: result.metadata ?? {},
			}));
		},
	});

	// VSA facade — shares the SQLite DB with the raw-message store so
	// `vsa_facts` lives next to the rest of the user data. The MCP
	// transport keeps the store open for the lifetime of the server, so
	// we don't wire a close hook (stdio transports terminate the process).
	const vsaDbPath = resolveSQLiteRawMessageDbPath(options.dbPath);
	const vsaStorage = await getSQLiteVsaStore({ dbPath: vsaDbPath });
	const vsa: VsaRecallFacade = createVsaRecall(vsaStorage);
	void closeSQLiteVsaStore; // re-exported for completeness; stdio never calls it.

	server.tool("memory.health", "Returns the health status of the memory store.", async () => {
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
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ ok: true, retrieval }) }],
		};
	});

	const searchSchema: ZodRawShape = {
		userId: z.string(),
		query: z.string().min(1),
		sources: z
			.array(z.enum(["memory", "insights", "knowledge"]))
			.optional()
			.describe("Default: ['memory','insights','knowledge']"),
		tiers: z
			.array(z.enum(["summary", "raw", "insight", "knowledge"]))
			.optional()
			.describe(
				"Per-tier evidence scope for synthesis. Default: ['summary','raw','insight','knowledge']. Ignored when `synthesize` is falsy.",
			),
		reasoningStrategy: z
			.enum(["none", "rewrite", "iterative", "union"])
			.optional()
			.describe(
				"LLM reasoning strategy. `rewrite` rephrases the query before embedding; `iterative` runs a planner that searches, notes evidence, and searches again; `union` merges the planner's evidence with the baseline top-k hits (evidence first, deduped, capped at limit). Requires `unified.reasoning.{queryRewriter,iterativePlanner}` to be wired into the server.",
			),
		synthesize: z
			.union([z.boolean(), z.object({ responseSchema: z.record(z.string(), z.unknown()).optional() })])
			.optional()
			.describe(
				"Opt-in LLM synthesis. `true` returns `{ answer, evidence, results, warnings }`. `synthesize.responseSchema` extracts `answer` from a JSON payload.",
			),
		// Top-level pass-through kept for backward-shaped callers; the SDK
		// coerces it into `synthesize.responseSchema` when present.
		responseSchema: z.record(z.string(), z.unknown()).optional(),
		limit: z.number().int().min(1).max(50).default(10),
		threshold: z
			.number()
			.min(-1)
			.max(1)
			.optional()
			.describe(
				"Optional similarity floor. Omit it to let the default RRF pipeline fuse the full candidate window.",
			),
		mergeStrategy: z.enum(["rrf", "similarity"]).optional(),
		includeRetrievalDiagnostics: z.boolean().optional(),
		botIds: z.array(z.string()).optional(),
		documentIds: z.array(z.string()).optional(),
		includeArchivedInsights: z.boolean().default(false),
		authToken: z.string().optional(),
	};

	const writeSchema: ZodRawShape = {
		userId: z.string(),
		embedOnInsert: z
			.boolean()
			.optional()
			.describe(
				"When true AND the host wired `unified.embedQuery`, fill in any missing " +
					"`embedding` server-side via that embedder. Required when the active " +
					"memory backend is sqlite-vec and the caller doesn't pre-embed.",
			),
		message: z
			.object({
				id: z.string().optional(),
				messageId: z.string().optional(),
				role: z.string(),
				content: z.union([z.string(), z.array(z.unknown())]),
				platform: z.string().optional(),
				botId: z.string().optional(),
				channel: z.string().optional(),
				person: z.string().optional(),
				timestamp: z.number().optional(),
				embedding: z.array(z.number()).optional(),
				embeddingModel: z.string().optional(),
				embeddingDimensions: z.number().optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			})
			.passthrough(),
	};

	const getSchema: ZodRawShape = {
		userId: z.string(),
		messageId: z.string(),
	};

	const reflectApplySchema: ZodRawShape = {
		userId: z.string(),
		query: z.string().min(1),
		ownerScopeUserId: z.string().describe("Required: who owns the writes."),
		botIds: z.array(z.string()).optional(),
		dateFrom: z.string().optional(),
		dateTo: z.string().optional(),
		tiers: z
			.array(z.enum(["summary", "raw", "insight", "knowledge"]))
			.optional()
			.describe("Default: ['summary','raw','insight','knowledge']"),
		limit: z.number().int().min(1).max(200).default(20),
		threshold: z.number().min(-1).max(1).default(0.7),
		dryRun: z.boolean().default(false),
		expectedVersion: z.string().optional(),
		llmPlanReviewMaxTokens: z.number().int().min(64).max(8192).optional(),
		authToken: z.string().optional(),
	};

	// Zod 4 schemas are not directly assignable to the MCP SDK's
	// AnySchema (z3.ZodTypeAny | z4.$ZodType) due to TypeScript's
	// structural checks. The runtime works correctly — only the
	// static type relationship needs the explicit cast.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.search",
		{
			title: "Search Memory",
			description:
				"Cross-source semantic search across raw messages, insights, and uploaded knowledge. Set `synthesize: true` to opt into LLM synthesis over the gathered evidence. With synthesis enabled, the response carries `answer`, `evidence`, `results`, and `warnings`; otherwise just `results`, `evidence`, and `count`.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: searchSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				query: string;
				sources?: ("memory" | "insights" | "knowledge")[];
				tiers?: Array<"summary" | "raw" | "insight" | "knowledge">;
				reasoningStrategy?: "none" | "rewrite" | "iterative" | "union";
				synthesize?: boolean | { responseSchema?: Record<string, unknown> };
				responseSchema?: Record<string, unknown>;
				limit?: number;
				threshold?: number;
				mergeStrategy?: "rrf" | "similarity";
				includeRetrievalDiagnostics?: boolean;
				botIds?: string[];
				documentIds?: string[];
				includeArchivedInsights?: boolean;
				authToken?: string;
			};
			const wantsSynthesis =
				typeof a.synthesize === "boolean"
					? a.synthesize
					: typeof a.synthesize === "object" && a.synthesize !== null;
			const responseSchema =
				typeof a.synthesize === "object" && a.synthesize !== null
					? (a.synthesize.responseSchema ?? a.responseSchema)
					: a.responseSchema;
			const input: SearchInput = {
				userId: a.userId,
				query: a.query,
				sources: a.sources,
				limit: a.limit,
				threshold: a.threshold,
				mergeStrategy: a.mergeStrategy,
				includeRetrievalDiagnostics: a.includeRetrievalDiagnostics,
				botIds: a.botIds,
				documentIds: a.documentIds,
				authToken: a.authToken,
				includeArchivedInsights: a.includeArchivedInsights,
				reasoningStrategy:
					a.reasoningStrategy === "rewrite" ||
					a.reasoningStrategy === "iterative" ||
					a.reasoningStrategy === "union"
						? a.reasoningStrategy
						: undefined,
				...(a.tiers ? { tiers: a.tiers } : {}),
				...(wantsSynthesis
					? {
							synthesize: {
								...(responseSchema ? { responseSchema } : {}),
							},
						}
					: {}),
			};
			const result = await search.search(input);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.writeRawMessage",
		{
			title: "Write Raw Message",
			description: "Persist a single raw message to the user's memory store.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: writeSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				embedOnInsert?: boolean;
				message: unknown;
			};
			const manager = (await rawStore.getManager()) as RawMessageManagerLike;
			const incoming = [a.message as RawMessage].map((m) => ({ ...m, userId: m.userId ?? a.userId }));

			const persisted = await persistRawMessages({
				manager,
				userId: a.userId,
				messages: incoming,
				embedOnInsert: a.embedOnInsert,
				unified: options.unified,
				externalIndex: options.unified?.rawMessageChildIndex,
			});
			const result = persisted.ids
				? { inserted: persisted.ids.length, ids: persisted.ids }
				: { inserted: persisted.count };
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							ok: true,
							count: persisted.count,
							result,
							...(persisted.warnings.length > 0 ? { warnings: persisted.warnings } : {}),
						}),
					},
				],
			};
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.getRawMessage",
		{
			title: "Get Raw Message",
			description: "Fetch a single raw message by its message id.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: getSchema as any,
		},
		async (args: unknown) => {
			const a = args as { userId: string; messageId: string };
			const manager = (await rawStore.getManager()) as RawMessageManagerLike;
			const row = await manager.getMessageById?.(a.messageId);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ message: row ?? null }),
					},
				],
			};
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.consolidate",
		{
			title: "Consolidate",
			description:
				"Agentic write-back: gathers evidence like `memory.search({ synthesize: true })`, builds a memory-consolidation plan, optionally asks the LLM to veto unsafe entries, then persists via the attached graph store + soft-deprecates via the storage adapter. Set `dryRun: true` to inspect the plan without writing.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: reflectApplySchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				query: string;
				ownerScopeUserId: string;
				botIds?: string[];
				dateFrom?: string;
				dateTo?: string;
				tiers?: Array<"summary" | "raw" | "insight" | "knowledge">;
				limit?: number;
				threshold?: number;
				dryRun?: boolean;
				expectedVersion?: string;
				llmPlanReviewMaxTokens?: number;
				authToken?: string;
			};
			const input: ApplyConsolidateInput = {
				userId: a.userId,
				query: a.query,
				ownerScope: { userId: a.ownerScopeUserId },
				botIds: a.botIds,
				dateFrom: a.dateFrom,
				dateTo: a.dateTo,
				tiers: a.tiers,
				limit: a.limit,
				threshold: a.threshold,
				dryRun: a.dryRun ?? false,
				expectedVersion: a.expectedVersion,
				authToken: a.authToken,
				llmPlanReview:
					a.llmPlanReviewMaxTokens !== undefined ? { maxTokens: a.llmPlanReviewMaxTokens } : undefined,
			};
			const result = await applyReflectedPlan(
				{ ...(options.unified ?? {}) },
				{ graphStore: options.graphStore, storage: options.storage },
				input,
				console,
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	const distillSchema: ZodRawShape = {
		userId: z.string(),
		messageId: z.string().min(1),
		content: z.string().min(1),
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.distill",
		{
			title: "Distill Entities",
			description:
				"Extract `EntityEdge`s from a single raw message via the host's `unified.entityExtractor`. Returns `{ edges, warnings }`. Without the extractor wired in, returns an empty list with a `distill_extractor_not_configured` warning. Persistence is the host's responsibility — the MCP transport cannot carry host-side `persist` callbacks. Call `distillRawMessage` directly from host code if you need round-trip persistence.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: distillSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				messageId: string;
				content: string;
			};
			const input: DistillInput = {
				userId: a.userId,
				messageId: a.messageId,
				content: a.content,
			};
			try {
				const result = await distillRawMessage(options.unified ?? {}, input, console);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				// biome-ignore lint/suspicious/noConsole: server-side error log — needed for ops triage
				console.error("[memory-store/mcp] distill failed:", error);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "distill failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	const deriveSchema: ZodRawShape = {
		userId: z.string(),
		query: z
			.string()
			.optional()
			.describe(
				"Optional topical query used to derive lexical keywords when `candidateTexts` is omitted. Loop-engine schedulers should pass the topic they want synthesized facts about (e.g. 'cat preferences'). Without it the lexical fallback uses `userId + botIds` which is rarely useful.",
			),
		botIds: z.array(z.string()).optional(),
		peers: z
			.array(
				z.object({
					kind: z.enum(["user", "agent"]),
					id: z.string().min(1),
				}),
			)
			.optional()
			.describe("Optional peer scope forwarded to the lexical candidate-fetch fallback."),
		factTypes: z
			.array(z.string())
			.optional()
			.describe("Optional FactType filter forwarded to the lexical candidate-fetch fallback."),
		dateFrom: z.string().optional(),
		dateTo: z.string().optional(),
		windowFrom: z.number().optional().describe("Optional time-window start (ms) forwarded to the deriver."),
		windowTo: z.number().optional().describe("Optional time-window end (ms) forwarded to the deriver."),
		candidateTexts: z
			.array(z.string())
			.optional()
			.describe(
				"Pre-computed candidate fact texts. When omitted, the SDK pulls up to `candidateLimit` (default 50) texts via the lexical sub-query.",
			),
		candidateLimit: z.number().int().min(1).max(500).optional(),
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.derive",
		{
			title: "Derive Facts",
			description:
				"Synthesize `DerivedFact`s over a window of candidate fact texts via the host's `unified.deriver`. Returns `{ facts, warnings }`. Without the deriver wired in, returns an empty list with a `derive_deriver_not_configured` warning. Persistence is the host's responsibility — the MCP transport cannot carry host-side `persist` callbacks. Call `deriveFacts` directly from host code if you need round-trip persistence.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: deriveSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				query?: string;
				botIds?: string[];
				peers?: Array<{ kind: "user" | "agent"; id: string }>;
				factTypes?: string[];
				dateFrom?: string;
				dateTo?: string;
				windowFrom?: number;
				windowTo?: number;
				candidateTexts?: string[];
				candidateLimit?: number;
			};
			const window =
				a.windowFrom !== undefined && a.windowTo !== undefined
					? { from: a.windowFrom, to: a.windowTo }
					: undefined;
			const input: DeriveInput = {
				userId: a.userId,
				...(a.query ? { query: a.query } : {}),
				botIds: a.botIds,
				...(a.peers && a.peers.length > 0 ? { peers: a.peers } : {}),
				...(a.factTypes && a.factTypes.length > 0 ? { factTypes: a.factTypes.filter(isFactType) } : {}),
				dateFrom: a.dateFrom,
				dateTo: a.dateTo,
				...(window ? { window } : {}),
				...(a.candidateTexts ? { candidateTexts: a.candidateTexts } : {}),
				...(a.candidateLimit !== undefined ? { candidateLimit: a.candidateLimit } : {}),
			};
			try {
				const result = await deriveFacts(options.unified ?? {}, input, console);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				// biome-ignore lint/suspicious/noConsole: server-side error log — needed for ops triage
				console.error("[memory-store/mcp] derive failed:", error);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "derive failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	const vsaVocabularyEntry: ZodRawShape = {
		label: z.string().min(1),
		vector: z.array(z.number()).describe("Float32 vector for the vocabulary entry."),
	};

	const vsaStoreSchema: ZodRawShape = {
		userId: z.string(),
		roleLabel: z.string().min(1),
		fillerLabel: z.string().min(1),
		roleVector: z.array(z.number()),
		fillerVector: z.array(z.number()),
		scopeTag: z.string().optional(),
		botId: z.string().optional(),
		factId: z.string().optional(),
	};

	const vsaRecallSchema: ZodRawShape = {
		userId: z.string(),
		roleLabel: z.string().min(1),
		roleVector: z.array(z.number()),
		vocabulary: z.array(z.object(vsaVocabularyEntry).passthrough()),
		scopeTag: z.string().optional(),
		botId: z.string().optional(),
		maxFacts: z.number().int().min(1).max(10_000).optional(),
	};

	const vsaListSchema: ZodRawShape = {
		userId: z.string(),
		scopeTag: z.string().optional(),
		botId: z.string().optional(),
		includeDeprecated: z.boolean().default(false),
	};

	const vsaForgetSchema: ZodRawShape = {
		userId: z.string(),
		factIds: z.array(z.string()).min(1),
		reason: z.string().optional(),
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.vsaStore",
		{
			title: "VSA Store Fact",
			description:
				"Persist a (role, filler) binding into the user's VSA memory. The vectors are stored as Float32 BLOBs alongside the labels; later `memory.vsaRecall` rebuilds the memory vector and picks the best vocabulary match.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: vsaStoreSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				roleLabel: string;
				fillerLabel: string;
				roleVector: number[];
				fillerVector: number[];
				scopeTag?: string;
				botId?: string;
				factId?: string;
			};
			try {
				const result = await vsa.storeFact({
					userId: a.userId,
					roleLabel: a.roleLabel,
					fillerLabel: a.fillerLabel,
					roleVector: a.roleVector,
					fillerVector: a.fillerVector,
					scopeTag: a.scopeTag,
					botId: a.botId,
					factId: a.factId,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "vsa.store failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.vsaRecall",
		{
			title: "VSA Recall",
			description:
				"Rebuild the user's VSA memory vector from stored (role, filler) facts, unbind by the requested role, and cleanup against the supplied vocabulary. Returns the best-match label plus a sorted score list and warnings (e.g. low confidence, dim mismatch).",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: vsaRecallSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				roleLabel: string;
				roleVector: number[];
				vocabulary: Array<{ label: string; vector: number[] }>;
				scopeTag?: string;
				botId?: string;
				maxFacts?: number;
			};
			try {
				const result = await vsa.recall({
					userId: a.userId,
					roleLabel: a.roleLabel,
					roleVector: a.roleVector,
					vocabulary: a.vocabulary,
					scopeTag: a.scopeTag,
					botId: a.botId,
					maxFacts: a.maxFacts,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "vsa.recall failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.vsaList",
		{
			title: "VSA List Facts",
			description:
				"List the (role, filler) facts stored for a user. Vectors are stripped from the response — for the underlying storage layer, query SQLite directly.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: vsaListSchema as any,
		},
		async (args: unknown) => {
			const a = args as {
				userId: string;
				scopeTag?: string;
				botId?: string;
				includeDeprecated?: boolean;
			};
			try {
				const facts = await vsa.listFacts({
					userId: a.userId,
					scopeTag: a.scopeTag,
					botId: a.botId,
					includeDeprecated: a.includeDeprecated,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ facts }) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "vsa.list failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.registerTool(
		"memory.vsaForget",
		{
			title: "VSA Forget Facts",
			description:
				"Soft-delete one or more VSA facts by id. Idempotent — facts already deprecated return `deprecatedCount: 0`.",
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects Zod schema type
			inputSchema: vsaForgetSchema as any,
		},
		async (args: unknown) => {
			const a = args as { userId: string; factIds: string[]; reason?: string };
			try {
				const result = await vsa.forget({
					userId: a.userId,
					factIds: a.factIds,
					reason: a.reason,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: (error as Error).message ?? "vsa.forget failed" }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// OKF v0.2 importer / exporter tools. They reuse the same McpServer
	// so `memory.okfImport` and `memory.okfExport` are available alongside
	// the rest of the memory-store tools without extra wiring.
	//
	// `@melandlabs/okf/mcp` is loaded through a non-literal string
	// specifier (the same pattern `memory-store/src/http.ts` uses for
	// `@melandlabs/okf/http`) so TypeScript can't resolve its types at
	// compile time. memory-store → okf and okf → memory-store form a
	// workspace cycle, and a static import here would force OKF's
	// `dist/mcp.d.ts` to exist before memory-store can emit its own
	// `dist/mcp.d.ts`. Loading lazily keeps the runtime contract
	// identical (OKF ships alongside memory-store as a regular
	// `dependency`) while letting pnpm 10 build memory-store first
	// in topological order without a type-level cycle.
	const okfMcpSpecifier: string = "@melandlabs/okf/mcp";
	const { registerOkfTools } = await import(okfMcpSpecifier);
	registerOkfTools(server, rawStore, {
		writeMessages: async (userId: string, messages: RawMessage[]) => {
			await persistRawMessages({
				manager: rawMessageManager,
				userId,
				messages,
				unified: options.unified,
				externalIndex: options.unified?.rawMessageChildIndex,
			});
		},
	});

	// Wire format on stdio is NDJSON — one JSON-RPC object per line.
	// This is the default set by `@modelcontextprotocol/sdk` v1.25.x's
	// `StdioServerTransport` (it appends `\n` on send and reads by `indexOf('\n')`).
	// If you fork a client, serialize with `JSON.stringify(obj) + '\n'`.
	const transport = new StdioServerTransport();
	await server.connect(transport);
	return server;
}

export type { MemoryStoreConfig };
