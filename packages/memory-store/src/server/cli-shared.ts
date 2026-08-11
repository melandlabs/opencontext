#!/usr/bin/env node
/**
 * Shared argv parsing + `unified.*` wiring for the memory-store CLI bins.
 *
 * Both `cli-http.ts` (the HTTP daemon) and `cli-mcp.ts` (the MCP daemon)
 * take the same `--embedding-provider` / `--*-backend` flag surface —
 * the MCP server exposes the same `searchUnifiedMemory` tool the HTTP
 * `/v1/search` route does, so they must speak the same config. This
 * module owns that surface so the two bins stay in lock-step.
 *
 * `--embedding-provider local` and every `--*-backend=chroma` value
 * require `@melandlabs/ai-rag` (a peer install — pulling it in adds
 * `@huggingface/transformers`, `chromadb`, and ~30 MB of ONNX weights
 * on first run). The bin errors with a clear remediation message if the
 * package is missing.
 */

import type { UnifiedSearchDeps } from "../config";
import { createRawMessageStore } from "../storage/raw-message-store";
import { searchInsightsWithSQLiteVec, isInsightSQLiteVecEnabled } from "../storage/sqlite-vector-index";

export interface UnifiedArgs {
	embeddingProvider: "local" | "openrouter" | "none";
	embeddingModel?: string;
	chromaUrl?: string;
	memoryBackend: "sqlite-vec" | "chroma" | "none";
	insightsBackend: "sqlite-vec" | "chroma" | "none";
	insightsCollection: string;
	knowledgeBackend: "chroma" | "none";
	knowledgeCollection: string;
}

interface AiRagModules {
	LocalTransformersEmbeddingProvider: new (opts: { modelName?: string }) => {
		embedQuery(text: string): Promise<number[]>;
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
		const [local, chroma] = await Promise.all([
			import("@melandlabs/ai-rag/local-transformers-embedding-provider"),
			import("@melandlabs/ai-rag/chroma-store"),
		]);
		return {
			LocalTransformersEmbeddingProvider:
				local.LocalTransformersEmbeddingProvider as AiRagModules["LocalTransformersEmbeddingProvider"],
			ChromaVectorStore: chroma.ChromaVectorStore as AiRagModules["ChromaVectorStore"],
		};
	} catch (error) {
		throw new Error(
			`--embedding-provider local / --*-backend=chroma require @melandlabs/ai-rag to be installed. ` +
				`Run \`pnpm add @melandlabs/ai-rag\` and try again. (${(error as Error).message})`,
		);
	}
}

export function parseUnifiedArgs(argv: string[]): UnifiedArgs {
	const env = process.env;
	const args: UnifiedArgs = {
		embeddingProvider: (env.EMBEDDING_PROVIDER as UnifiedArgs["embeddingProvider"] | undefined) ?? "none",
		embeddingModel: env.EMBEDDING_MODEL,
		chromaUrl: env.CHROMA_URL,
		memoryBackend: (env.MEMORY_BACKEND as UnifiedArgs["memoryBackend"] | undefined) ?? "none",
		insightsBackend: (env.INSIGHTS_BACKEND as UnifiedArgs["insightsBackend"] | undefined) ?? "none",
		insightsCollection: env.INSIGHTS_COLLECTION ?? "opencontext_insights",
		knowledgeBackend: (env.KNOWLEDGE_BACKEND as UnifiedArgs["knowledgeBackend"] | undefined) ?? "none",
		knowledgeCollection: env.KNOWLEDGE_COLLECTION ?? "opencontext_knowledge",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const takeValue = () => {
			if (next === undefined) throw new Error(`[memory-store/http] ${arg} requires a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--embedding-provider":
				args.embeddingProvider = takeValue() as UnifiedArgs["embeddingProvider"];
				break;
			case "--embedding-model":
				args.embeddingModel = takeValue();
				break;
			case "--chroma-url":
				args.chromaUrl = takeValue();
				break;
			case "--memory-backend":
				args.memoryBackend = takeValue() as UnifiedArgs["memoryBackend"];
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
		}
	}
	for (const [name, value] of [
		["--embedding-provider", args.embeddingProvider],
		["--memory-backend", args.memoryBackend],
		["--insights-backend", args.insightsBackend],
		["--knowledge-backend", args.knowledgeBackend],
	] as const) {
		const allowed = ["local", "openrouter", "none", "chroma", "sqlite-vec"];
		if (!(allowed as readonly string[]).includes(value)) {
			throw new Error(`[memory-store/cli] ${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
		}
	}
	return args;
}

export async function buildUnified(args: UnifiedArgs): Promise<UnifiedSearchDeps> {
	const unified: UnifiedSearchDeps = {};
	const log = (msg: string) => console.warn(`[memory-store/cli] ${msg}`);

	const wantsAiRag =
		args.embeddingProvider === "local" ||
		args.memoryBackend === "chroma" ||
		args.insightsBackend === "chroma" ||
		args.knowledgeBackend === "chroma";
	const aiRag = wantsAiRag ? await loadAiRag() : null;

	// ── 1. Wire the embedder (if any) — must happen before any backend
	//      that consults it.
	if (args.embeddingProvider === "local") {
		const provider = new aiRag!.LocalTransformersEmbeddingProvider({ modelName: args.embeddingModel });
		unified.embedQuery = async ({ query }) => provider.embedQuery(query);
		log(
			`embedQuery wired via LocalTransformersEmbeddingProvider (model=${args.embeddingModel ?? "Xenova/all-MiniLM-L6-v2"})`,
		);
	} else if (args.embeddingProvider === "openrouter") {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error("--embedding-provider openrouter requires OPENROUTER_API_KEY in the environment");
		}
		const model = args.embeddingModel ?? "text-embedding-3-small";
		const baseURL = "https://openrouter.ai/api/v1";
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
			return embedding;
		};
		log(`embedQuery wired via openrouter (model=${model})`);
	}

	// ── 2. Wire the memory source backend.
	if (args.memoryBackend === "sqlite-vec") {
		const store = createRawMessageStore({ env: undefined });
		const manager = await store.getManager();
		if (typeof manager.searchMessagesSemantically !== "function") {
			throw new Error(
				"the active raw-message manager does not implement searchMessagesSemantically; " +
					"sqlite-vec ANN for the memory source is unavailable in this build",
			);
		}
		unified.searchRawMessagesAnn = async ({ userId, queryEmbedding, limit, threshold, botId }) => {
			const rows = (await manager.searchMessagesSemantically!({
				userId,
				queryEmbedding,
				limit,
				threshold,
				botId,
			})) as Array<{ id: string; content: string; similarity: number; metadata?: Record<string, unknown> }>;
			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				similarity: r.similarity,
				metadata: r.metadata ?? {},
			}));
		};
		log("memory backend wired via sqlite-vec (uses the manager's searchMessagesSemantically)");
	} else if (args.memoryBackend === "chroma") {
		if (!args.chromaUrl)
			throw new Error("--memory-backend=chroma requires --chroma-url <url> (or CHROMA_URL env)");
		const store = new aiRag!.ChromaVectorStore({
			url: args.chromaUrl,
			collectionName: "opencontext_raw_messages",
		});
		unified.searchRawMessagesAnn = async ({ queryEmbedding, limit, threshold }) => {
			const results = await store.similaritySearchWithOptions(queryEmbedding, { limit: limit + 1 });
			return results
				.filter((r) => r.score >= threshold)
				.map((r) => ({ id: r.id, content: r.content, similarity: r.score, metadata: r.metadata ?? {} }));
		};
		log("memory backend wired via chroma (collection=opencontext_raw_messages)");
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
		const store = new aiRag!.ChromaVectorStore({
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
		const store = new aiRag!.ChromaVectorStore({
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

	return unified;
}

/**
 * Subcommand-agnostic help text used by `cli-http --help` and
 * `cli-mcp --help`. The caller prepends the bin-specific intro
 * (server-only flags like `--port`/`--host`).
 */
export function printUnifiedHelp(): void {
	console.log(`Embedding (wires unified.embedQuery):
  --embedding-provider <name>     local | openrouter | none
                                  (env: EMBEDDING_PROVIDER, default: none)
  --embedding-model <name>        Model name
                                  (env: EMBEDDING_MODEL; local → Xenova/all-MiniLM-L6-v2,
                                  openrouter → text-embedding-3-small)
  Note: "local" dynamically imports @melandlabs/ai-rag (a peer install).

Cross-source search (wires unified.searchKnowledge / searchInsights / searchRawMessagesAnn):
  --chroma-url <url>              Chroma server URL
                                  (env: CHROMA_URL; required when any *-backend=chroma)
  --memory-backend <name>         sqlite-vec | chroma | none
                                  (env: MEMORY_BACKEND, default: none)
  --insights-backend <name>       sqlite-vec | chroma | none
                                  (env: INSIGHTS_BACKEND, default: none)
  --insights-collection <name>    Chroma collection (default: opencontext_insights)
  --knowledge-backend <name>      chroma | none
                                  (env: KNOWLEDGE_BACKEND, default: none)
  --knowledge-collection <name>   Chroma collection (default: opencontext_knowledge)
  Note: the chroma backends dynamically import @melandlabs/ai-rag.`);
}
