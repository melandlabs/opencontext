#!/usr/bin/env node
/**
 * `opencontext` — single CLI entry that dispatches to the MCP or HTTP daemon.
 *
 * Subcommands:
 *   mcp    Start the MCP server on stdio (default when no subcommand given).
 *   http   Start the HTTP server (Hono) on the configured host/port.
 *
 * The HTTP subcommand accepts the same flag surface as the standalone
 * `opencontext-memory-http` bin in `@melandlabs/memory-store`. The bin
 * imports `LocalTransformersEmbeddingProvider` and `ChromaVectorStore`
 * from `@melandlabs/ai-rag` (bundled into the facade) for the local /
 * openrouter / chroma paths, and uses the memory-store's own
 * `searchMessagesSemantically` for the sqlite-vec memory path.
 *
 * Usage:
 *   opencontext                  # default → MCP on stdio
 *   opencontext mcp              # explicit MCP
 *   opencontext http             # HTTP on default 127.0.0.1:7421
 *   opencontext http --port 8080 # HTTP on a custom port
 *
 *   opencontext http --embedding-provider local --memory-backend sqlite-vec
 *   opencontext http --embedding-provider openrouter \\
 *     --chroma-url http://127.0.0.1:8000 \\
 *     --memory-backend chroma --insights-backend chroma --knowledge-backend chroma
 *
 * The HTTP daemon reads `MEMORY_HTTP_PORT` / `MEMORY_HTTP_HOST` as defaults.
 * Imports go through the facade's main bundle so every bin shares one
 * canonical copy of the runtime code.
 */

import { ChromaVectorStore } from "@melandlabs/ai-rag/chroma-store";
import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag/local-transformers-embedding-provider";
import { createRawMessageStore } from "@melandlabs/memory-store";
import { parseOkfArgs, printOkfHelp, startOkf } from "@melandlabs/okf";
import { startHttpServer, startMcpServer } from "../index.js";
import { parseDoctorArgs, runDoctor } from "./doctor.js";

// Shape that satisfies the `unified` field of `MemoryStoreConfig` (which
// is what `startHttpServer` accepts). Kept local to this bin so we don't
// depend on the internal `UnifiedSearchDeps` type.
interface UnifiedConfig {
	embedQuery?: (input: { userId: string; query: string; authToken?: string }) => Promise<number[]>;
	searchRawMessagesAnn?: (input: {
		userId: string;
		queryEmbedding: number[];
		limit: number;
		threshold: number;
		botId?: string;
	}) => Promise<
		Array<{ id: string; content: string; similarity: number; metadata: Record<string, unknown> }>
	>;
	searchInsights?: (input: {
		userId: string;
		query: string;
		limit: number;
		threshold: number;
		botIds?: string[];
		includeArchived?: boolean;
		authToken?: string;
	}) => Promise<
		Array<{ id: string; content: string; similarity: number; metadata: Record<string, unknown> }>
	>;
	searchKnowledge?: (input: {
		userId: string;
		query: string;
		options: { limit: number; threshold: number; documentIds?: string[] };
		authToken?: string;
	}) => Promise<
		Array<{
			chunkId: string;
			documentId: string;
			documentName: string;
			content: string;
			similarity: number;
			chunkIndex: number;
		}>
	>;
}

interface UnifiedArgs {
	embeddingProvider: "local" | "openrouter" | "none";
	embeddingModel?: string;
	embeddingCacheDir?: string;
	chromaUrl?: string;
	memoryBackend: "sqlite-vec" | "chroma" | "none";
	insightsBackend: "sqlite-vec" | "chroma" | "none";
	insightsCollection: string;
	knowledgeBackend: "chroma" | "none";
	knowledgeCollection: string;
}

interface HttpArgs extends UnifiedArgs {
	port: number;
	host: string;
}

interface McpArgs extends UnifiedArgs {
	name?: string;
	version?: string;
}

const ALLOWED_UNIFIED_VALUES = ["local", "openrouter", "none", "chroma", "sqlite-vec"] as const;

function unifiedFromEnv(env: NodeJS.ProcessEnv): UnifiedArgs {
	return {
		embeddingProvider: (env.EMBEDDING_PROVIDER as UnifiedArgs["embeddingProvider"] | undefined) ?? "none",
		embeddingModel: env.EMBEDDING_MODEL,
		embeddingCacheDir: env.LOCAL_EMBEDDING_CACHE_DIR,
		chromaUrl: env.CHROMA_URL,
		memoryBackend: (env.MEMORY_BACKEND as UnifiedArgs["memoryBackend"] | undefined) ?? "none",
		insightsBackend: (env.INSIGHTS_BACKEND as UnifiedArgs["insightsBackend"] | undefined) ?? "none",
		insightsCollection: env.INSIGHTS_COLLECTION ?? "opencontext_insights",
		knowledgeBackend: (env.KNOWLEDGE_BACKEND as UnifiedArgs["knowledgeBackend"] | undefined) ?? "none",
		knowledgeCollection: env.KNOWLEDGE_COLLECTION ?? "opencontext_knowledge",
	};
}

function applyUnifiedFlag(args: UnifiedArgs, arg: string, takeValue: () => string, logPrefix: string): void {
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
		default:
			throw new Error(`${logPrefix} unknown flag: ${arg}`);
	}
}

function validateUnifiedArgs(args: UnifiedArgs, logPrefix: string): void {
	for (const [name, value] of [
		["--embedding-provider", args.embeddingProvider],
		["--memory-backend", args.memoryBackend],
		["--insights-backend", args.insightsBackend],
		["--knowledge-backend", args.knowledgeBackend],
	] as const) {
		if (!(ALLOWED_UNIFIED_VALUES as readonly string[]).includes(value)) {
			throw new Error(
				`${logPrefix} ${name} must be one of: ${ALLOWED_UNIFIED_VALUES.join(", ")} (got "${value}")`,
			);
		}
	}
}

function parseHttpArgs(argv: string[]): HttpArgs {
	const env = process.env;
	const args: HttpArgs = {
		...unifiedFromEnv(env),
		port: Number.parseInt(env.MEMORY_HTTP_PORT ?? "7421", 10),
		host: env.MEMORY_HTTP_HOST ?? "127.0.0.1",
	};
	const logPrefix = "[opencontext/http]";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const takeValue = () => {
			if (next === undefined) throw new Error(`${logPrefix} ${arg} requires a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--port":
				args.port = Number.parseInt(takeValue(), 10);
				break;
			case "--host":
				args.host = takeValue();
				break;
			case "--help":
			case "-h":
				printHttpHelp();
				process.exit(0);
				break;
			default:
				applyUnifiedFlag(args, arg, takeValue, logPrefix);
		}
	}
	if (!Number.isFinite(args.port) || args.port <= 0) {
		throw new Error(`${logPrefix} invalid --port: ${args.port}`);
	}
	validateUnifiedArgs(args, logPrefix);
	return args;
}

function parseMcpArgs(argv: string[]): McpArgs {
	const env = process.env;
	const args: McpArgs = {
		...unifiedFromEnv(env),
		name: env.MEMORY_MCP_NAME,
		version: env.MEMORY_MCP_VERSION,
	};
	const logPrefix = "[opencontext/mcp]";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const takeValue = () => {
			if (next === undefined) throw new Error(`${logPrefix} ${arg} requires a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--name":
				args.name = takeValue();
				break;
			case "--version":
				args.version = takeValue();
				break;
			case "--help":
			case "-h":
				printMcpHelp();
				process.exit(0);
				break;
			default:
				applyUnifiedFlag(args, arg, takeValue, logPrefix);
		}
	}
	validateUnifiedArgs(args, logPrefix);
	return args;
}

async function buildUnified(args: UnifiedArgs): Promise<UnifiedConfig> {
	const unified: UnifiedConfig = {};
	const log = (msg: string) => console.warn(`[opencontext/http] ${msg}`);

	// ── 1. Wire the embedder (if any) — must happen before any backend
	//      that consults it.
	if (args.embeddingProvider === "local") {
		try {
			const provider = new LocalTransformersEmbeddingProvider({
				modelName: args.embeddingModel,
				cacheDir: args.embeddingCacheDir,
			});
			unified.embedQuery = async ({ query }) => provider.embedQuery(query);
			log(
				`embedQuery wired via LocalTransformersEmbeddingProvider (model=${args.embeddingModel ?? "Xenova/all-MiniLM-L6-v2"})`,
			);
		} catch (error) {
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
			// biome-ignore lint/style/noNonNullAssertion: checked above that manager.searchMessagesSemantically is a function.
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
		const store = new ChromaVectorStore({ url: args.chromaUrl, collectionName: "opencontext_raw_messages" });
		unified.searchRawMessagesAnn = async ({ queryEmbedding, limit, threshold }) => {
			const results = await store.similaritySearchWithOptions(queryEmbedding, { limit: limit + 1 });
			return results
				.filter((r) => r.score >= threshold)
				.map((r) => ({ id: r.id, content: r.content, similarity: r.score, metadata: r.metadata ?? {} }));
		};
		log("memory backend wired via chroma (collection=opencontext_raw_messages)");
	}

	// ── 3. Wire the insights source backend.
	if (args.insightsBackend === "chroma") {
		if (!args.chromaUrl)
			throw new Error("--insights-backend=chroma requires --chroma-url <url> (or CHROMA_URL env)");
		if (!unified.embedQuery)
			throw new Error("--insights-backend=chroma requires --embedding-provider local|openrouter");
		const store = new ChromaVectorStore({ url: args.chromaUrl, collectionName: args.insightsCollection });
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
		const store = new ChromaVectorStore({ url: args.chromaUrl, collectionName: args.knowledgeCollection });
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

function printTopHelp(): void {
	console.log(`opencontext — single CLI for the OpenContext facade.

Usage:
  opencontext [command] [options]

Commands:
  mcp     Start the MCP server on stdio (default)
  http    Start the HTTP server
  doctor  Run health checks against the local install
  okf     OKF v0.2 (Open Knowledge Format) importer / exporter

Run "opencontext <command> --help" for command-specific options.

Examples:
  opencontext
  opencontext mcp
  opencontext mcp --embedding-provider local --memory-backend sqlite-vec
  opencontext http
  opencontext http --port 8080
  opencontext doctor
  opencontext doctor --json
  opencontext doctor --section memory-store
  opencontext okf ingest ./my-wiki --user=alice --json
  opencontext okf emit --user=alice --output=./export-2026-08-19`);
}

function printHttpHelp(): void {
	console.log(`opencontext http — standalone OpenContext HTTP daemon.

Usage:
  opencontext http [options]

Server:
  --port <port>                   Port to listen on (default: 7421, env: MEMORY_HTTP_PORT)
  --host <host>                   Host to bind (default: 127.0.0.1, env: MEMORY_HTTP_HOST)

Embedding (wires unified.embedQuery):
  --embedding-provider <name>     local | openrouter | none
                                  (env: EMBEDDING_PROVIDER, default: none)
  --embedding-model <name>        Model name
                                  (env: EMBEDDING_MODEL; local → Xenova/all-MiniLM-L6-v2,
                                  openrouter → text-embedding-3-small)
  --embedding-cache-dir <path>    Directory for local ONNX model weights
                                  (env: LOCAL_EMBEDDING_CACHE_DIR; default:
                                  ~/.cache/opencontext/local-embeddings)

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

Examples:
  opencontext http
  opencontext http --port 8080

  # Local ONNX embedder + sqlite-vec ANN (no API key, no extra services).
  opencontext http --embedding-provider local --memory-backend sqlite-vec

  # Wire everything via a running Chroma server
  opencontext http \\
    --embedding-provider openrouter \\
    --chroma-url http://127.0.0.1:8000 \\
    --memory-backend chroma \\
    --insights-backend chroma \\
    --knowledge-backend chroma`);
}

function printMcpHelp(): void {
	console.log(`opencontext mcp — standalone OpenContext MCP daemon (stdio).

Usage:
  opencontext mcp [options]

Server identity (advertised to MCP clients):
  --name <name>                   Server name (env: MEMORY_MCP_NAME)
  --version <version>             Server version (env: MEMORY_MCP_VERSION)

Embedding (wires unified.embedQuery):
  --embedding-provider <name>     local | openrouter | none
                                  (env: EMBEDDING_PROVIDER, default: none)
  --embedding-model <name>        Model name
                                  (env: EMBEDDING_MODEL; local → Xenova/all-MiniLM-L6-v2,
                                  openrouter → text-embedding-3-small)
  --embedding-cache-dir <path>    Directory for local ONNX model weights
                                  (env: LOCAL_EMBEDDING_CACHE_DIR; default:
                                  ~/.cache/opencontext/local-embeddings)

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

Examples:
  # Default — all three *_not_configured warnings remain
  opencontext mcp

  # Local ONNX embedder + sqlite-vec ANN (no API key, no extra services)
  opencontext mcp --embedding-provider local --memory-backend sqlite-vec

  # Wire everything via a running Chroma server
  opencontext mcp \\
    --embedding-provider openrouter \\
    --chroma-url http://127.0.0.1:8000 \\
    --memory-backend chroma \\
    --insights-backend chroma \\
    --knowledge-backend chroma`);
}

async function startMcp(argv: string[]): Promise<void> {
	const args = parseMcpArgs(argv);
	const unified = await buildUnified(args);
	const server = await startMcpServer({ unified, name: args.name, version: args.version });
	console.error("[opencontext/mcp] listening on stdio");

	const shutdown = async (signal: NodeJS.Signals) => {
		console.error(`[opencontext/mcp] ${signal} received, shutting down…`);
		await server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

async function startHttp(argv: string[]): Promise<void> {
	const args = parseHttpArgs(argv);
	const unified = await buildUnified(args);
	const { url, stop } = await startHttpServer({ port: args.port, host: args.host, unified });
	console.log(`[opencontext/http] listening at ${url}`);

	const shutdown = async (signal: NodeJS.Signals) => {
		console.log(`[opencontext/http] ${signal} received, shutting down…`);
		await stop();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const head = argv[0];

	// No args, or explicit "mcp" (case-insensitive) → MCP on stdio.
	if (head === undefined || head === "mcp" || head === "MCP") {
		await startMcp(argv.slice(1));
		return;
	}

	if (head === "http" || head === "HTTP") {
		await startHttp(argv.slice(1));
		return;
	}

	if (head === "doctor" || head === "DOCTOR") {
		await runDoctor(parseDoctorArgs(argv.slice(1)));
		return;
	}

	if (head === "okf" || head === "OKF") {
		const okfArgs = parseOkfArgs(argv.slice(1));
		if (okfArgs.action === "help") {
			printOkfHelp();
			process.exit(0);
		}
		const result = await startOkf(okfArgs, { packageVersion: "@melandlabs/opencontext" });
		process.exit(result.exit);
	}

	if (head === "--help" || head === "-h") {
		printTopHelp();
		return;
	}

	console.error(`[opencontext] unknown command: ${head}`);
	printTopHelp();
	process.exit(1);
}

main().catch((error) => {
	console.error("[opencontext] fatal:", error);
	process.exit(1);
});
