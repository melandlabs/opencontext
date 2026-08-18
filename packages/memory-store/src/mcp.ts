/**
 * @melandlabs/memory-store/mcp — MCP server entry.
 *
 * Spawns an MCP server (stdio transport by default) that exposes the
 * memory-store as tools any MCP client (Claude Code, etc.) can invoke.
 *
 * Tools registered:
 *   - memory.search            → SearchOutput (read-only; set
 *                                `synthesize: true` for LLM synthesis)
 *   - memory.writeRawMessage   → { ok: boolean }
 *   - memory.getRawMessage     → RawMessage | null
 *   - memory.reflectWithPlan   → ApplyReflectOutput (agentic write-back)
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

import type { RawMessage } from "@melandlabs/indexeddb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeSQLiteVsaStore, getSQLiteVsaStore } from "@melandlabs/sqlite";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { UnifiedSearchDeps } from "./config";
import type { MemoryStoreConfig } from "./index";
import { type ApplyReflectInput, applyReflectedPlan } from "./search/apply-reflect";
import { createUnifiedSearch } from "./search/unified-search";
import type { SearchInput } from "./search/utilities";
import { createVsaRecall, type VsaRecallFacade } from "./search/vsa";
import { upsertRawMessagesToChroma } from "./storage/chroma-memory-index";
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
	getMessageById?: RawMessageGetFn;
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

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<McpServer> {
	const server = new McpServer({
		name: options.name ?? DEFAULT_NAME,
		version: options.version ?? DEFAULT_VERSION,
	});

	const rawStore = createRawMessageStore({
		env: options.env,
	});
	const search = createUnifiedSearch(options.unified);

	// VSA facade — shares the SQLite DB with the raw-message store so
	// `vsa_facts` lives next to the rest of the user data. The MCP
	// transport keeps the store open for the lifetime of the server, so
	// we don't wire a close hook (stdio transports terminate the process).
	const vsaDbPath = resolveSQLiteRawMessageDbPath(options.dbPath);
	const vsaStorage = await getSQLiteVsaStore({ dbPath: vsaDbPath });
	const vsa: VsaRecallFacade = createVsaRecall(vsaStorage);
	void closeSQLiteVsaStore; // re-exported for completeness; stdio never calls it.

	server.tool("memory.health", "Returns the health status of the memory store.", async () => ({
		content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
	}));

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
		threshold: z.number().min(-1).max(1).default(0.7),
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
				synthesize?: boolean | { responseSchema?: Record<string, unknown> };
				responseSchema?: Record<string, unknown>;
				limit?: number;
				threshold?: number;
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
				botIds: a.botIds,
				documentIds: a.documentIds,
				authToken: a.authToken,
				includeArchivedInsights: a.includeArchivedInsights,
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
			const messages =
				a.embedOnInsert === true ? await embedMissingMessages(incoming, options.unified ?? {}) : incoming;

			let result: unknown;
			if (typeof manager.upsertRawMessages === "function") {
				result = await manager.upsertRawMessages({
					userId: a.userId,
					messages,
				});
			} else if (typeof manager.storeMessages === "function") {
				const ids = await manager.storeMessages(messages);
				result = { inserted: ids.length, ids };
			} else {
				throw new Error("active raw-message manager exposes neither upsertRawMessages nor storeMessages");
			}
			try {
				await upsertRawMessagesToChroma(messages as never);
			} catch (error) {
				// biome-ignore lint/suspicious/noConsole: intentional server logging
				console.warn("[memory-store/mcp] chroma upsert failed:", error);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ ok: true, count: messages.length, result }),
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
		"memory.reflectWithPlan",
		{
			title: "Reflect With Plan",
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
			const input: ApplyReflectInput = {
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

	const transport = new StdioServerTransport();
	await server.connect(transport);
	return server;
}

export type { MemoryStoreConfig };
