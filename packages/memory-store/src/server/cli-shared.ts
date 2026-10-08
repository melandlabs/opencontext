#!/usr/bin/env node
/**
 * Shared argv parsing + `unified.*` wiring for the memory-store CLI bins.
 *
 * Both `cli-http.ts` (the HTTP daemon) and `cli-mcp.ts` (the MCP daemon)
 * take the same `--embedding-provider` / `--*-backend` flag surface —
 * the MCP server exposes the same `memory.search` tool the HTTP
 * `/v1/search` route does, so they must speak the same config. This
 * module owns that surface so the two bins stay in lock-step.
 *
 * `--embedding-provider local` and the insight/knowledge Chroma backends
 * require `@melandlabs/ai-rag`. Raw-message Chroma, LanceDB, and Milvus use
 * the existing `@melandlabs/rag` stores. Missing optional dependencies fail
 * at startup with an actionable error.
 */

import { ChromaVectorStore } from "@melandlabs/rag/chroma-vector-store";
import type { IVectorStore } from "@melandlabs/rag/vector-service";
import type { UnifiedSearchDeps } from "../config";
import { createExtractiveEvidenceSelector } from "../search/evidence-selector";
import {
	type IterativeRecallCompletionOptions,
	createIterativeRecallPlanner,
} from "../search/iterative-recall";
import { createUserVoiceRewriter } from "../search/query-rewriter";
import { RawMessageChildVectorIndex } from "../storage/raw-message-child-vector-index";
import { createRawMessageStore } from "../storage/raw-message-store";
import { isInsightSQLiteVecEnabled, searchInsightsWithSQLiteVec } from "../storage/sqlite-vector-index";

export interface UnifiedArgs {
	embeddingProvider: "local" | "openrouter" | "none";
	embeddingModel?: string;
	embeddingCacheDir?: string;
	embeddingPooling?: "mean" | "cls";
	chunkMaxTokens?: number;
	chunkOverlapTokens?: number;
	rerankerProvider: "local" | "none";
	rerankerModel?: string;
	rerankerCacheDir?: string;
	rerankerBatchSize?: number;
	rerankerMaxTokens?: number;
	rerankerCandidateMode?: "window" | "matched-chunks";
	rrfDenseWeight?: number;
	rrfLexicalWeight?: number;
	rrfK?: number;
	sessionNeighborSeedK?: number;
	sessionNeighborWindow?: number;
	sessionNeighborMode?: "union" | "protected";
	sessionNeighborMaxSlots?: number;
	chromaUrl?: string;
	memoryBackend: "sqlite-vec" | "chroma" | "lancedb" | "milvus" | "none";
	lancedbUri?: string;
	lancedbTable?: string;
	milvusAddress?: string;
	milvusToken?: string;
	milvusDatabase?: string;
	milvusCollection?: string;
	milvusDimension?: number;
	insightsBackend: "sqlite-vec" | "chroma" | "none";
	insightsCollection: string;
	knowledgeBackend: "chroma" | "none";
	knowledgeCollection: string;
	/**
	 * Wire `unified.reasoning.{queryRewriter, iterativePlanner}` from the
	 * `OPENCONTEXT_LLM_*` env vars. When false, reasoning providers stay
	 * unset and `POST /v1/search` / `memory.search` requests with
	 * `reasoningStrategy: "rewrite" | "iterative"` will surface a
	 * `_not_configured` warning and fall back to the default search path.
	 */
	reasoning: boolean;
	/** OpenAI-compatible base URL the reasoning LLM is served from. */
	reasoningBaseUrl?: string;
	/** Reasoning LLM model identifier. */
	reasoningModel?: string;
	/** Request timeout for reasoning LLM calls (ms). @default 30000 */
	reasoningTimeoutMs?: number;
}

interface AiRagModules {
	LocalTransformersEmbeddingProvider: new (opts: {
		modelName?: string;
		cacheDir?: string;
		pooling?: "mean" | "cls";
	}) => {
		embedQuery(text: string): Promise<number[]>;
		embedDocuments(texts: string[]): Promise<number[][]>;
		getTokenCounter(): Promise<(text: string) => number>;
		getMaxTokens(): number;
		getModelName(): string;
	};
	LocalTransformersReranker: new (opts: {
		modelName?: string;
		cacheDir?: string;
		batchSize?: number;
		maxTokens?: number;
		candidateMode?: "window" | "matched-chunks";
	}) => {
		rerank(input: {
			query: string;
			candidates: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
			topK?: number;
		}): Promise<Array<{ id: string; score: number }>>;
		warmup(): Promise<void>;
		getModelName(): string;
		getMaxTokens(): number;
	};
	ChromaVectorStore: new (opts: { url?: string; collectionName: string }) => {
		similaritySearchWithOptions(
			queryEmbedding: number[],
			options: { limit?: number },
		): Promise<
			Array<{
				id: string;
				content: string;
				score: number;
				documentId: string;
				metadata?: Record<string, unknown>;
			}>
		>;
	};
}

async function loadAiRag(): Promise<AiRagModules> {
	try {
		const [local, reranker, chroma] = await Promise.all([
			import("@melandlabs/ai-rag/local-transformers-embedding-provider"),
			import("@melandlabs/ai-rag/local-transformers-reranker"),
			import("@melandlabs/ai-rag/chroma-store"),
		]);
		return {
			LocalTransformersEmbeddingProvider:
				local.LocalTransformersEmbeddingProvider as AiRagModules["LocalTransformersEmbeddingProvider"],
			LocalTransformersReranker:
				reranker.LocalTransformersReranker as AiRagModules["LocalTransformersReranker"],
			ChromaVectorStore: chroma.ChromaVectorStore as AiRagModules["ChromaVectorStore"],
		};
	} catch (error) {
		throw new Error(
			`Local embedding/reranking and insight/knowledge Chroma require @melandlabs/ai-rag to be installed. Run \`pnpm add @melandlabs/ai-rag\` and try again. (${(error as Error).message})`,
		);
	}
}

export function unifiedArgsFromEnv(env: NodeJS.ProcessEnv = process.env): UnifiedArgs {
	return {
		embeddingProvider: (env.EMBEDDING_PROVIDER as UnifiedArgs["embeddingProvider"] | undefined) ?? "none",
		embeddingModel: env.EMBEDDING_MODEL,
		embeddingCacheDir: env.LOCAL_EMBEDDING_CACHE_DIR,
		rerankerProvider: (env.RERANKER_PROVIDER as UnifiedArgs["rerankerProvider"] | undefined) ?? "none",
		rerankerModel: env.LOCAL_RERANKER_MODEL,
		rerankerCacheDir: env.LOCAL_RERANKER_CACHE_DIR,
		rerankerBatchSize: env.LOCAL_RERANKER_BATCH_SIZE
			? Number.parseInt(env.LOCAL_RERANKER_BATCH_SIZE, 10)
			: undefined,
		rerankerMaxTokens: env.LOCAL_RERANKER_MAX_TOKENS
			? Number.parseInt(env.LOCAL_RERANKER_MAX_TOKENS, 10)
			: undefined,
		rrfDenseWeight: env.OPENCONTEXT_RRF_DENSE_WEIGHT
			? Number.parseFloat(env.OPENCONTEXT_RRF_DENSE_WEIGHT)
			: undefined,
		rrfLexicalWeight: env.OPENCONTEXT_RRF_LEXICAL_WEIGHT
			? Number.parseFloat(env.OPENCONTEXT_RRF_LEXICAL_WEIGHT)
			: undefined,
		rrfK: env.OPENCONTEXT_RRF_K ? Number.parseInt(env.OPENCONTEXT_RRF_K, 10) : undefined,
		sessionNeighborSeedK: env.OPENCONTEXT_SESSION_NEIGHBOR_SEED_K
			? Number.parseInt(env.OPENCONTEXT_SESSION_NEIGHBOR_SEED_K, 10)
			: undefined,
		sessionNeighborWindow: env.OPENCONTEXT_SESSION_NEIGHBOR_WINDOW
			? Number.parseInt(env.OPENCONTEXT_SESSION_NEIGHBOR_WINDOW, 10)
			: undefined,
		sessionNeighborMode:
			env.OPENCONTEXT_SESSION_NEIGHBOR_MODE === "union" ||
			env.OPENCONTEXT_SESSION_NEIGHBOR_MODE === "protected"
				? env.OPENCONTEXT_SESSION_NEIGHBOR_MODE
				: undefined,
		sessionNeighborMaxSlots: env.OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS
			? Number.parseInt(env.OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS, 10)
			: undefined,
		chromaUrl: env.CHROMA_URL,
		memoryBackend: (env.MEMORY_BACKEND as UnifiedArgs["memoryBackend"] | undefined) ?? "none",
		lancedbUri: env.LANCEDB_URI,
		lancedbTable: env.LANCEDB_TABLE,
		milvusAddress: env.MILVUS_ADDRESS,
		milvusToken: env.MILVUS_TOKEN,
		milvusDatabase: env.MILVUS_DATABASE,
		milvusCollection: env.MILVUS_COLLECTION,
		milvusDimension: env.MILVUS_DIMENSION ? Number.parseInt(env.MILVUS_DIMENSION, 10) : undefined,
		insightsBackend: (env.INSIGHTS_BACKEND as UnifiedArgs["insightsBackend"] | undefined) ?? "none",
		insightsCollection: env.INSIGHTS_COLLECTION ?? "opencontext_insights",
		knowledgeBackend: (env.KNOWLEDGE_BACKEND as UnifiedArgs["knowledgeBackend"] | undefined) ?? "none",
		knowledgeCollection: env.KNOWLEDGE_COLLECTION ?? "opencontext_knowledge",
		reasoning: env.REASONING === "1" || env.REASONING === "true",
		reasoningBaseUrl: env.OPENCONTEXT_LLM_BASE_URL,
		reasoningModel: env.OPENCONTEXT_LLM_MODEL,
		reasoningTimeoutMs: env.OPENCONTEXT_LLM_TIMEOUT_MS
			? Number.parseInt(env.OPENCONTEXT_LLM_TIMEOUT_MS, 10)
			: undefined,
	};
}

/** Return false for server-specific flags; callers decide whether to reject them. */
export function applyUnifiedFlag(args: UnifiedArgs, arg: string, takeValue: () => string): boolean {
	switch (arg) {
		case "--embedding-provider":
			args.embeddingProvider = takeValue() as UnifiedArgs["embeddingProvider"];
			break;
		case "--embedding-model":
			args.embeddingModel = takeValue();
			break;
		case "--embedding-cache-dir":
			args.embeddingCacheDir = takeValue();
			break;
		case "--embedding-pooling":
			args.embeddingPooling = takeValue() as UnifiedArgs["embeddingPooling"];
			break;
		case "--chunk-max-tokens":
			args.chunkMaxTokens = Number(takeValue());
			break;
		case "--chunk-overlap-tokens":
			args.chunkOverlapTokens = Number(takeValue());
			break;
		case "--reranker-provider":
			args.rerankerProvider = takeValue() as UnifiedArgs["rerankerProvider"];
			break;
		case "--reranker-model":
			args.rerankerModel = takeValue();
			break;
		case "--reranker-cache-dir":
			args.rerankerCacheDir = takeValue();
			break;
		case "--reranker-batch-size":
			args.rerankerBatchSize = Number.parseInt(takeValue(), 10);
			break;
		case "--reranker-max-tokens":
			args.rerankerMaxTokens = Number.parseInt(takeValue(), 10);
			break;
		case "--reranker-candidate-mode":
			args.rerankerCandidateMode = takeValue() as UnifiedArgs["rerankerCandidateMode"];
			break;
		case "--chroma-url":
			args.chromaUrl = takeValue();
			break;
		case "--memory-backend":
			args.memoryBackend = takeValue() as UnifiedArgs["memoryBackend"];
			break;
		case "--lancedb-uri":
			args.lancedbUri = takeValue();
			break;
		case "--lancedb-table":
			args.lancedbTable = takeValue();
			break;
		case "--milvus-address":
			args.milvusAddress = takeValue();
			break;
		case "--milvus-token":
			args.milvusToken = takeValue();
			break;
		case "--milvus-database":
			args.milvusDatabase = takeValue();
			break;
		case "--milvus-collection":
			args.milvusCollection = takeValue();
			break;
		case "--milvus-dimension":
			args.milvusDimension = Number.parseInt(takeValue(), 10);
			break;
		case "--insights-backend":
			args.insightsBackend = takeValue() as UnifiedArgs["insightsBackend"];
			break;
		case "--insights-collection":
			args.insightsCollection = takeValue();
			break;
		case "--knowledge-backend":
			args.knowledgeBackend = takeValue() as UnifiedArgs["knowledgeBackend"];
			break;
		case "--knowledge-collection":
			args.knowledgeCollection = takeValue();
			break;
		case "--reasoning":
			args.reasoning = true;
			break;
		case "--no-reasoning":
			args.reasoning = false;
			break;
		case "--reasoning-base-url":
			args.reasoningBaseUrl = takeValue();
			break;
		case "--reasoning-model":
			args.reasoningModel = takeValue();
			break;
		case "--reasoning-timeout-ms":
			args.reasoningTimeoutMs = Number.parseInt(takeValue(), 10);
			break;
		default:
			return false;
	}
	return true;
}

export function validateUnifiedArgs(args: UnifiedArgs, logPrefix = "[memory-store/cli]"): void {
	const validate = (name: string, value: string, allowed: string[]) => {
		if (!allowed.includes(value)) {
			throw new Error(`${logPrefix} ${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
		}
	};
	validate("--embedding-provider", args.embeddingProvider, ["local", "openrouter", "none"]);
	validate("--reranker-provider", args.rerankerProvider, ["local", "none"]);
	validate("--memory-backend", args.memoryBackend, ["sqlite-vec", "chroma", "lancedb", "milvus", "none"]);
	validate("--insights-backend", args.insightsBackend, ["sqlite-vec", "chroma", "none"]);
	validate("--knowledge-backend", args.knowledgeBackend, ["chroma", "none"]);
	if (args.embeddingPooling !== undefined) {
		validate("--embedding-pooling", args.embeddingPooling, ["mean", "cls"]);
		if (args.embeddingProvider !== "local")
			throw new Error("--embedding-pooling requires --embedding-provider local");
	}
	if (
		args.milvusDimension !== undefined &&
		(!Number.isInteger(args.milvusDimension) || args.milvusDimension <= 0)
	) {
		throw new Error(`${logPrefix} --milvus-dimension must be a positive integer`);
	}
	for (const [name, value] of [
		["--reranker-batch-size", args.rerankerBatchSize],
		["--reranker-max-tokens", args.rerankerMaxTokens],
		["OPENCONTEXT_RRF_K", args.rrfK],
		["OPENCONTEXT_SESSION_NEIGHBOR_SEED_K", args.sessionNeighborSeedK],
		["OPENCONTEXT_SESSION_NEIGHBOR_WINDOW", args.sessionNeighborWindow],
		["OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS", args.sessionNeighborMaxSlots],
	] as const) {
		if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
			throw new Error(`${logPrefix} ${name} must be a positive integer`);
		}
	}
	for (const [name, value] of [
		["OPENCONTEXT_RRF_DENSE_WEIGHT", args.rrfDenseWeight],
		["OPENCONTEXT_RRF_LEXICAL_WEIGHT", args.rrfLexicalWeight],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`${logPrefix} ${name} must be a finite non-negative number`);
		}
	}
	if (args.rrfK !== undefined && args.rrfK <= 0) {
		throw new Error(`${logPrefix} OPENCONTEXT_RRF_K must be positive`);
	}
	if (args.sessionNeighborWindow !== undefined && args.sessionNeighborWindow <= 0) {
		throw new Error(`${logPrefix} OPENCONTEXT_SESSION_NEIGHBOR_WINDOW must be positive`);
	}
	if (args.sessionNeighborSeedK !== undefined && args.sessionNeighborSeedK <= 0) {
		throw new Error(`${logPrefix} OPENCONTEXT_SESSION_NEIGHBOR_SEED_K must be positive`);
	}
	if (args.sessionNeighborMaxSlots !== undefined && args.sessionNeighborMaxSlots <= 0) {
		throw new Error(`${logPrefix} OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS must be positive`);
	}
	if (args.chunkMaxTokens !== undefined || args.chunkOverlapTokens !== undefined) {
		if (args.embeddingProvider !== "local")
			throw new Error("Tokenizer-aware chunking requires --embedding-provider local");
		if (
			!Number.isSafeInteger(args.chunkMaxTokens) ||
			(args.chunkMaxTokens ?? 0) <= 0 ||
			!Number.isSafeInteger(args.chunkOverlapTokens) ||
			(args.chunkOverlapTokens ?? -1) < 0 ||
			(args.chunkOverlapTokens ?? 0) >= (args.chunkMaxTokens ?? 0)
		) {
			throw new Error(
				"--chunk-max-tokens and --chunk-overlap-tokens require positive size and 0 <= overlap < size",
			);
		}
	}
	if (args.rerankerCandidateMode !== undefined) {
		validate("--reranker-candidate-mode", args.rerankerCandidateMode, ["window", "matched-chunks"]);
		if (args.rerankerProvider !== "local")
			throw new Error("--reranker-candidate-mode requires a local reranker");
	}
}

export function parseUnifiedArgs(argv: string[]): UnifiedArgs {
	const args = unifiedArgsFromEnv();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		applyUnifiedFlag(args, arg, () => {
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`[memory-store/http] ${arg} requires a value`);
			i += 1;
			return value;
		});
	}
	validateUnifiedArgs(args);
	return args;
}

export async function buildUnified(args: UnifiedArgs): Promise<UnifiedSearchDeps> {
	const unified: UnifiedSearchDeps = {};
	const log = (msg: string) => console.warn(`[memory-store/cli] ${msg}`);
	if (args.rrfDenseWeight !== undefined || args.rrfLexicalWeight !== undefined) {
		unified.defaultRrfWeights = {
			semantic: args.rrfDenseWeight ?? 1,
			lexical: args.rrfLexicalWeight ?? 1,
		};
	}
	if (args.rrfK !== undefined) unified.defaultRrfK = args.rrfK;
	if (args.sessionNeighborSeedK !== undefined || args.sessionNeighborWindow !== undefined) {
		unified.defaultSessionNeighborExpansion = {
			seedLimit: args.sessionNeighborSeedK ?? 12,
			window: args.sessionNeighborWindow ?? 1,
			mode: args.sessionNeighborMode ?? "union",
			...(args.sessionNeighborMaxSlots !== undefined
				? { maxNeighborSlots: args.sessionNeighborMaxSlots }
				: {}),
		};
	}

	const wantsAiRag =
		args.embeddingProvider === "local" ||
		args.rerankerProvider === "local" ||
		args.insightsBackend === "chroma" ||
		args.knowledgeBackend === "chroma";
	const aiRag = wantsAiRag ? await loadAiRag() : null;

	// ── 1. Wire the embedder (if any) — must happen before any backend
	//      that consults it.
	if (args.embeddingProvider === "local") {
		try {
			if (!aiRag) {
				throw new Error("ai-rag modules not loaded");
			}
			const provider = new aiRag.LocalTransformersEmbeddingProvider({
				modelName: args.embeddingModel,
				cacheDir: args.embeddingCacheDir,
				pooling: args.embeddingPooling,
			});
			if (args.chunkMaxTokens !== undefined && args.chunkOverlapTokens !== undefined) {
				if (args.chunkMaxTokens + 2 > provider.getMaxTokens()) {
					throw new Error("Document chunk budget exceeds the embedding input limit including special tokens");
				}
				const maxTokens = args.chunkMaxTokens;
				const overlapTokens = args.chunkOverlapTokens;
				unified.getDocumentChunking = async () => ({
					maxTokens,
					overlapTokens,
					countTokens: await provider.getTokenCounter(),
				});
			}
			unified.embeddingInfo = {
				provider: "local",
				model: provider.getModelName(),
				maxTokens: provider.getMaxTokens(),
			};
			unified.embedQuery = async ({ query }) => {
				const embedding = await provider.embedQuery(query);
				if (unified.embeddingInfo) unified.embeddingInfo.dimensions = embedding.length;
				return embedding;
			};
			unified.embedDocuments = async ({ texts }) => {
				const embeddings = await provider.embedDocuments(texts);
				if (unified.embeddingInfo && embeddings[0]) {
					unified.embeddingInfo.dimensions = embeddings[0].length;
				}
				return embeddings;
			};
			log(
				`embedQuery wired via LocalTransformersEmbeddingProvider (model=${provider.getModelName()}, pooling=${args.embeddingPooling ?? "mean"})`,
			);
		} catch (error) {
			if (args.chunkMaxTokens !== undefined || args.embeddingPooling !== undefined) throw error;
			log(`Warning: Failed to initialize LocalTransformersEmbeddingProvider: ${(error as Error).message}`);
			log("Semantic search will be disabled. The server will continue with keyword-only search.");
			log("To fix: Ensure the model is downloaded or check your network connection to huggingface.co");
			// Don't set unified.embedQuery - the system will fall back to lexical search
		}
	} else if (args.embeddingProvider === "openrouter") {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error("--embedding-provider openrouter requires OPENROUTER_API_KEY in the environment");
		}
		const model = args.embeddingModel ?? "text-embedding-3-small";
		const baseURL = "https://openrouter.ai/api/v1";
		unified.embeddingInfo = { provider: "openrouter", model };
		unified.embedQuery = async ({ query }) => {
			const res = await fetch(`${baseURL}/embeddings`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
					"HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://opencontext.ai",
					"X-Title": "opencontext AI",
				},
				body: JSON.stringify({ model, input: query }),
			});
			if (!res.ok) {
				throw new Error(`openrouter embeddings ${res.status}: ${await res.text()}`);
			}
			const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
			const embedding = body.data?.[0]?.embedding;
			if (!embedding) throw new Error("openrouter embeddings response missing data[0].embedding");
			if (unified.embeddingInfo) unified.embeddingInfo.dimensions = embedding.length;
			return embedding;
		};
		log(`embedQuery wired via openrouter (model=${model})`);
	}

	if (args.rerankerProvider === "local") {
		if (!aiRag) throw new Error("Local reranker modules were not loaded");
		const reranker = new aiRag.LocalTransformersReranker({
			modelName: args.rerankerModel,
			cacheDir: args.rerankerCacheDir,
			batchSize: args.rerankerBatchSize,
			maxTokens: args.rerankerMaxTokens,
			candidateMode: args.rerankerCandidateMode,
		});
		// A configured reranker is a required ranking stage. Warm it up at
		// startup so download/model incompatibility cannot silently turn a
		// paid benchmark run into an RRF-only run.
		await reranker.warmup();
		unified.reranker = reranker;
		unified.rerankerInfo = {
			provider: "local",
			model: reranker.getModelName(),
			maxTokens: reranker.getMaxTokens(),
			ready: true,
		};
		log(`reranker wired via local Transformers.js (model=${reranker.getModelName()})`);
	} else {
		unified.rerankerInfo = { provider: "none", ready: false };
	}

	// ── 2. Wire the memory source backend. SQLite remains the source of
	//      truth for parents, child offsets, and lexical search. External
	//      stores index only independently embedded child chunks.
	if (args.memoryBackend !== "none") {
		if (args.memoryBackend === "chroma" && !args.chromaUrl) {
			throw new Error("--memory-backend=chroma requires --chroma-url <url> (or CHROMA_URL env)");
		}
		if (args.memoryBackend === "lancedb" && !args.lancedbUri) {
			throw new Error("--memory-backend=lancedb requires --lancedb-uri <uri> (or LANCEDB_URI env)");
		}
		if (args.memoryBackend === "milvus" && !args.milvusAddress) {
			throw new Error("--memory-backend=milvus requires --milvus-address <address> (or MILVUS_ADDRESS env)");
		}
		if (args.memoryBackend === "lancedb") {
			try {
				await import("@lancedb/lancedb");
			} catch (error) {
				throw new Error(
					`LanceDB requires the optional dependency @lancedb/lancedb (${(error as Error).message})`,
				);
			}
		}
		if (args.memoryBackend === "milvus") {
			try {
				await import("@zilliz/milvus2-sdk-node");
			} catch (error) {
				throw new Error(
					`Milvus requires the optional dependency @zilliz/milvus2-sdk-node (${(error as Error).message})`,
				);
			}
		}
		const rawStore = createRawMessageStore({ env: undefined });
		const manager = await rawStore.getManager();
		if (
			typeof manager.getRawMessageSearchChunks !== "function" ||
			typeof manager.getRawMessageSearchIndexStats !== "function"
		) {
			throw new Error(
				`${args.memoryBackend} child retrieval requires the SQLite raw-message catalog; the Postgres manager remains on the legacy parent fallback in this release`,
			);
		}

		if (typeof manager.lexicalSearchMessages === "function") {
			unified.searchRawMessagesLexical = async (input) => {
				// biome-ignore lint/style/noNonNullAssertion: guarded above
				const rows = (await manager.lexicalSearchMessages!(input)) as Array<{
					id: string;
					content: string;
					similarity: number;
					metadata?: Record<string, unknown>;
				}>;
				return rows.map((row) => ({ ...row, metadata: row.metadata ?? {} }));
			};
		}
		if (typeof manager.getRawMessageSessionNeighbors === "function") {
			unified.searchRawMessageNeighbors = async ({
				userId,
				sessionId,
				messageSequences,
				window,
				includeDeprecated,
			}) => {
				const rows =
					(await manager.getRawMessageSessionNeighbors?.({
						userId,
						sessionId,
						messageSequences,
						window,
						includeDeprecated,
					})) ?? [];
				return rows.map((row) => ({
					id: row.messageId,
					content: row.content,
					similarity: 0,
					metadata: {
						...(row.metadata ?? {}),
						userId: row.userId,
						platform: row.platform,
						botId: row.botId,
						...(row.channel ? { channel: row.channel } : {}),
						...(row.person ? { person: row.person } : {}),
						...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}),
						...(row.messageSequence !== undefined ? { messageSequence: row.messageSequence } : {}),
						sourceMessageId: row.messageId,
					},
				}));
			};
		}

		let externalStore: IVectorStore | undefined;
		if (args.memoryBackend === "chroma") {
			externalStore = new ChromaVectorStore({
				url: args.chromaUrl as string,
				collectionName: "opencontext_raw_message_chunks",
			});
		} else if (args.memoryBackend === "lancedb") {
			const { LanceDBStore } = await import("@melandlabs/rag/lancedb-store");
			externalStore = new LanceDBStore({
				uri: args.lancedbUri as string,
				tableName: args.lancedbTable ?? "opencontext_raw_message_chunks",
				defaultFusion: "rrf",
				candidateMultiplier: 4,
			});
		} else if (args.memoryBackend === "milvus") {
			const { MilvusStore } = await import("@melandlabs/rag/milvus-store");
			externalStore = new MilvusStore({
				address: args.milvusAddress as string,
				token: args.milvusToken,
				database: args.milvusDatabase,
				collectionName: args.milvusCollection ?? "opencontext_raw_message_chunks",
				dimension: args.milvusDimension,
				defaultFusion: "rrf",
				candidateMultiplier: 4,
			});
		}

		if (args.memoryBackend === "sqlite-vec") {
			if (typeof manager.searchMessagesSemantically !== "function") {
				throw new Error("sqlite-vec child search is unavailable in the active raw-message manager");
			}
			unified.searchRawMessagesAnn = async ({ userId, queryEmbedding, limit, threshold, botId }) => {
				// biome-ignore lint/style/noNonNullAssertion: guarded above
				const rows = (await manager.searchMessagesSemantically!({
					userId,
					queryEmbedding,
					limit,
					threshold,
					botId,
				})) as Array<{
					id: string;
					content: string;
					similarity: number;
					metadata?: Record<string, unknown>;
				}>;
				return rows.map((row) => ({ ...row, metadata: row.metadata ?? {} }));
			};
		} else if (externalStore) {
			const childIndex = new RawMessageChildVectorIndex({
				backend: args.memoryBackend,
				store: externalStore,
				catalog: {
					getMessageById: (messageId) => manager.getMessageById(messageId),
					// biome-ignore lint/style/noNonNullAssertion: guarded above
					getRawMessageSearchChunks: (input) => manager.getRawMessageSearchChunks!(input),
				},
			});
			unified.rawMessageChildIndex = childIndex;
			unified.searchRawMessagesAnn = (input) => childIndex.search(input);
			if (args.memoryBackend !== "chroma") {
				unified.searchRawMessagesHybrid = (input) => childIndex.search({ ...input, hybrid: true });
			}
		}

		unified.getRawMessageRetrievalStatus = async () => {
			// biome-ignore lint/style/noNonNullAssertion: guarded above
			const stats = await manager.getRawMessageSearchIndexStats!();
			const embeddingDimensions = unified.embeddingInfo?.dimensions;
			const dimensionMismatch =
				embeddingDimensions !== undefined &&
				stats.embeddingDimensions.length > 0 &&
				!stats.embeddingDimensions.includes(embeddingDimensions);
			const semanticReady =
				Boolean(unified.embedQuery) &&
				(args.memoryBackend === "sqlite-vec" ? stats.semanticReady : stats.embeddedChunkCount > 0) &&
				!dimensionMismatch;
			return {
				backend: args.memoryBackend,
				embeddingProvider: unified.embeddingInfo?.provider,
				embeddingModel: unified.embeddingInfo?.model,
				embeddingDimensions,
				childCount: stats.chunkCount,
				embeddedChildCount: stats.embeddedChunkCount,
				indexedDimensions: stats.embeddingDimensions,
				semanticReady,
				lexicalReady: stats.lexicalReady,
				semanticDegradedReason: dimensionMismatch
					? "semantic_dimension_mismatch"
					: !unified.embedQuery
						? "semantic_unavailable"
						: stats.embeddedChunkCount === 0
							? "semantic_child_vectors_empty"
							: undefined,
				rerankerProvider: unified.rerankerInfo?.provider,
				rerankerModel: unified.rerankerInfo?.model,
				rerankerReady: unified.rerankerInfo?.ready ?? false,
			};
		};
		log(`memory backend wired via ${args.memoryBackend} with SQLite child catalog and lexical search`);
	}

	// ── 3. Wire the insights source backend.
	if (args.insightsBackend === "sqlite-vec" && isInsightSQLiteVecEnabled()) {
		if (!unified.embedQuery) {
			throw new Error("--insights-backend=sqlite-vec requires --embedding-provider local|openrouter");
		}
		const embedQuery = unified.embedQuery;
		unified.searchInsights = async ({ userId, query, limit, threshold, botIds, includeArchived }) => {
			const emb = await embedQuery({ userId, query });
			const rows = await searchInsightsWithSQLiteVec({
				userId,
				queryEmbedding: emb,
				limit,
				threshold,
				botIds,
				includeArchived,
			});
			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				similarity: r.score,
				metadata: r.metadata ?? {},
			}));
		};
		log("insights backend wired via sqlite-vec");
	} else if (args.insightsBackend === "chroma") {
		if (!args.chromaUrl)
			throw new Error("--insights-backend=chroma requires --chroma-url <url> (or CHROMA_URL env)");
		if (!unified.embedQuery)
			throw new Error("--insights-backend=chroma requires --embedding-provider local|openrouter");
		if (!aiRag) {
			throw new Error("ai-rag modules not loaded");
		}
		const store = new aiRag.ChromaVectorStore({
			url: args.chromaUrl,
			collectionName: args.insightsCollection,
		});
		const embedQuery = unified.embedQuery;
		unified.searchInsights = async ({ query, limit, threshold }) => {
			const emb = await embedQuery({ userId: "", query });
			const results = await store.similaritySearchWithOptions(emb, { limit: limit + 1 });
			return results
				.filter((r) => r.score >= threshold)
				.map((r) => ({ id: r.id, content: r.content, similarity: r.score, metadata: r.metadata ?? {} }));
		};
		log(`insights backend wired via chroma (collection=${args.insightsCollection})`);
	}

	// ── 4. Wire the knowledge source backend.
	if (args.knowledgeBackend === "chroma") {
		if (!args.chromaUrl)
			throw new Error("--knowledge-backend=chroma requires --chroma-url <url> (or CHROMA_URL env)");
		if (!unified.embedQuery)
			throw new Error("--knowledge-backend=chroma requires --embedding-provider local|openrouter");
		if (!aiRag) {
			throw new Error("ai-rag modules not loaded");
		}
		const store = new aiRag.ChromaVectorStore({
			url: args.chromaUrl,
			collectionName: args.knowledgeCollection,
		});
		const embedQuery = unified.embedQuery;
		unified.searchKnowledge = async ({ query, options }) => {
			const emb = await embedQuery({ userId: "", query });
			const results = await store.similaritySearchWithOptions(emb, { limit: options.limit + 1 });
			return results
				.filter((r) => r.score >= options.threshold)
				.map((r, i) => ({
					chunkId: r.id,
					documentId: r.documentId || String(r.metadata?.documentId ?? r.id),
					documentName: String(r.metadata?.documentName ?? ""),
					content: r.content,
					similarity: r.score,
					chunkIndex: i,
				}));
		};
		log(`knowledge backend wired via chroma (collection=${args.knowledgeCollection})`);
	}

	// ── 5. Wire the reasoning providers (query rewriter + iterative
	//      planner). Off by default — hosts opt in via `--reasoning` or
	//      `REASONING=1`. Backed by the same OPENCONTEXT_LLM_* env vars the
	//      `@melandlabs/opencontext/memory-reasoning` helper uses, so the
	//      .env the user already has for the facade CLI is reused as-is.
	if (args.reasoning) {
		const apiKey = process.env.OPENCONTEXT_LLM_API_KEY;
		if (!apiKey) {
			throw new Error(
				"--reasoning requires OPENCONTEXT_LLM_API_KEY (and ideally OPENCONTEXT_LLM_BASE_URL / OPENCONTEXT_LLM_MODEL) in the environment",
			);
		}
		const baseUrl =
			args.reasoningBaseUrl ?? process.env.OPENCONTEXT_LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
		const model = args.reasoningModel ?? process.env.OPENCONTEXT_LLM_MODEL ?? "openai/gpt-4o-mini";
		const timeoutMs = args.reasoningTimeoutMs ?? 30_000;
		const reasoningEffort = process.env.OPENCONTEXT_LLM_REASONING_EFFORT?.trim();
		const reasoningProvider = process.env.OPENCONTEXT_LLM_PROVIDER?.trim();
		if (reasoningEffort && !["none", "minimal", "low", "medium", "high"].includes(reasoningEffort)) {
			throw new Error("OPENCONTEXT_LLM_REASONING_EFFORT must be none, minimal, low, medium, or high");
		}
		const reasoningHost = new URL(baseUrl).hostname;
		if (reasoningProvider && reasoningHost !== "openrouter.ai" && !reasoningHost.endsWith(".openrouter.ai")) {
			throw new Error("OPENCONTEXT_LLM_PROVIDER requires an OpenRouter base URL");
		}

		const complete = async (
			prompt: string,
			requestOptions?: IterativeRecallCompletionOptions,
		): Promise<string> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			timer.unref?.();
			try {
				const res = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
						"HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://opencontext.ai",
						"X-Title": "opencontext AI",
					},
					body: JSON.stringify({
						model,
						messages: requestOptions?.messages ?? [{ role: "user", content: prompt }],
						temperature: 0,
						...(reasoningProvider
							? { provider: { order: [reasoningProvider], allow_fallbacks: false } }
							: {}),
						...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
					}),
					signal: controller.signal,
				});
				if (!res.ok) throw new Error(`reasoning LLM ${res.status}: ${await res.text()}`);
				const body = (await res.json()) as {
					provider?: string;
					choices?: Array<{ message?: { content?: string } }>;
				};
				if (reasoningProvider && body.provider?.toLowerCase() !== reasoningProvider.toLowerCase()) {
					throw new Error(
						`reasoning LLM provider mismatch: expected ${reasoningProvider}, got ${body.provider ?? "none"}`,
					);
				}
				const text = body.choices?.[0]?.message?.content?.trim();
				if (!text) throw new Error("reasoning LLM response missing choices[0].message.content");
				return text;
			} finally {
				clearTimeout(timer);
			}
		};

		const rewriteStyle = process.env.OPENCONTEXT_LLM_QUERY_REWRITE_STYLE?.trim();
		if (rewriteStyle && rewriteStyle !== "user-voice" && rewriteStyle !== "evidence") {
			throw new Error("OPENCONTEXT_LLM_QUERY_REWRITE_STYLE must be user-voice or evidence");
		}
		const queryRewriter = createUserVoiceRewriter({
			complete,
			...(rewriteStyle === "evidence" ? { style: "evidence", maxVariants: 3 } : {}),
		});
		const iterativePlanner = createIterativeRecallPlanner({ complete });

		if (!unified.reasoning) unified.reasoning = {};
		unified.reasoning.queryRewriter = queryRewriter;
		const semanticMerge = process.env.OPENCONTEXT_LLM_QUERY_REWRITE_SEMANTIC_MERGE?.trim();
		if (semanticMerge && semanticMerge !== "max-score" && semanticMerge !== "rrf") {
			throw new Error("OPENCONTEXT_LLM_QUERY_REWRITE_SEMANTIC_MERGE must be max-score or rrf");
		}
		if (semanticMerge === "rrf") {
			unified.reasoning.rewriteSemanticMerge = "rrf";
			log("query rewrite wired to semantic variant rank fusion under RRF");
		}
		if (process.env.OPENCONTEXT_LLM_QUERY_REWRITE_LEXICAL === "1") {
			unified.reasoning.rewriteLexical = true;
			log("query rewrite wired to lexical retrieval under RRF");
		}
		unified.reasoning.iterativePlanner = iterativePlanner;
		if (process.env.OPENCONTEXT_LLM_EVIDENCE_SELECTION === "1") {
			unified.reasoning.evidenceSelector = createExtractiveEvidenceSelector({ complete });
			log("extractive evidence selection wired after ranking");
		}
		log(`reasoning wired (model=${model}, baseUrl=${baseUrl}, provider=${reasoningProvider ?? "auto"})`);
	}

	return unified;
}

/**
 * Subcommand-agnostic help text used by `cli-http --help` and
 * `cli-mcp --help`. The caller prepends the bin-specific intro
 * (server-only flags like `--port`/`--host`).
 */
export function printUnifiedHelp(): void {
	// biome-ignore lint/suspicious/noConsole: intentional CLI help output
	console.log(`Embedding (wires unified.embedQuery):
  --embedding-provider <name>     local | openrouter | none
                                  (env: EMBEDDING_PROVIDER, default: none)
  --embedding-model <name>        Model name
  --embedding-pooling <mode>      Local mean (default) or cls pooling; BGE-M3 uses cls
                                  (env: EMBEDDING_MODEL; local → Xenova/all-MiniLM-L6-v2,
                                  openrouter → text-embedding-3-small)
	--embedding-cache-dir <path>    Local embedding cache (env: LOCAL_EMBEDDING_CACHE_DIR)
  --chunk-max-tokens <int>        Opt-in exact model-tokenizer document size (e.g. 384)
  --chunk-overlap-tokens <int>    Required overlap with --chunk-max-tokens (e.g. 64)
                                  Requires local embeddings; existing indexes are not migrated
  Note: "local" dynamically imports @melandlabs/ai-rag (a peer install).

Reranking (after RRF/source fusion, before final Top-K):
  --reranker-provider <name>      local | none
                                  (env: RERANKER_PROVIDER, default: none)
  --reranker-model <name>         Local sequence-classification model
                                  (env: LOCAL_RERANKER_MODEL,
                                  default: Xenova/ms-marco-MiniLM-L-6-v2)
  --reranker-cache-dir <path>     Persistent model cache (env: LOCAL_RERANKER_CACHE_DIR)
  --reranker-batch-size <int>     Pair scoring batch size (env: LOCAL_RERANKER_BATCH_SIZE,
                                  default: 8)
  --reranker-max-tokens <int>     Query/document pair token limit
                                  (env: LOCAL_RERANKER_MAX_TOKENS, default: 512)
  --reranker-candidate-mode <mode> window (default) or matched-chunks (token-budgeted hit scoring)

Retrieval experiments (disabled unless configured):
  OPENCONTEXT_RRF_DENSE_WEIGHT / OPENCONTEXT_RRF_LEXICAL_WEIGHT
  OPENCONTEXT_RRF_K
  OPENCONTEXT_SESSION_NEIGHBOR_SEED_K / OPENCONTEXT_SESSION_NEIGHBOR_WINDOW
  OPENCONTEXT_SESSION_NEIGHBOR_MODE=union|protected
  OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS

Cross-source search (wires unified.searchKnowledge / searchInsights / searchRawMessagesAnn):
  --chroma-url <url>              Chroma server URL
                                  (env: CHROMA_URL; required when any *-backend=chroma)
  --memory-backend <name>         sqlite-vec | chroma | lancedb | milvus | none
                                  (env: MEMORY_BACKEND, default: none)
  --lancedb-uri <uri>             LanceDB directory or URI (env: LANCEDB_URI)
  --lancedb-table <name>          Optional table name (env: LANCEDB_TABLE)
  --milvus-address <address>      Milvus endpoint (env: MILVUS_ADDRESS)
  --milvus-token <token>          Optional Milvus token (env: MILVUS_TOKEN)
  --milvus-database <name>        Optional database (env: MILVUS_DATABASE)
  --milvus-collection <name>      Optional collection (env: MILVUS_COLLECTION)
  --milvus-dimension <int>        Optional vector dimension (env: MILVUS_DIMENSION)
  --insights-backend <name>       sqlite-vec | chroma | none
                                  (env: INSIGHTS_BACKEND, default: none)
  --insights-collection <name>    Chroma collection (default: opencontext_insights)
  --knowledge-backend <name>      chroma | none
                                  (env: KNOWLEDGE_BACKEND, default: none)
  --knowledge-collection <name>   Chroma collection (default: opencontext_knowledge)
  Notes: memory Chroma uses @melandlabs/rag; insight/knowledge Chroma use
  @melandlabs/ai-rag. LanceDB and Milvus require their optional peer dependencies.

Reasoning (wires unified.reasoning.{queryRewriter, iterativePlanner}):
  --reasoning                     Enable the LLM reasoning layer so /v1/search and
                                  memory.search can honor reasoningStrategy:
                                    "rewrite"    — first-person memory-check rephrase
                                    "iterative"  — planner that searches, notes evidence,
                                                   searches again
                                  (env: REASONING=1, default: off)
  --no-reasoning                  Explicitly disable even if REASONING=1 is set.
  --reasoning-base-url <url>      OpenAI-compatible base URL for the reasoning LLM.
                                  (env: OPENCONTEXT_LLM_BASE_URL, default: https://openrouter.ai/api/v1)
  --reasoning-model <name>        Reasoning LLM model identifier.
                                  (env: OPENCONTEXT_LLM_MODEL, default: openai/gpt-4o-mini)
  --reasoning-timeout-ms <int>    Per-request timeout (default: 30000).

  Required env when --reasoning is set:
    OPENCONTEXT_LLM_API_KEY        Bearer token (no default)
    OPENCONTEXT_LLM_BASE_URL       (optional) overrides --reasoning-base-url
    OPENCONTEXT_LLM_MODEL          (optional) overrides --reasoning-model
    OPENCONTEXT_LLM_REASONING_EFFORT
                                   (optional) none | minimal | low | medium | high`);
}
