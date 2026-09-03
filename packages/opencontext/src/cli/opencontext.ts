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
 * delegates embedding, child indexing, retrieval backend, and reasoning
 * wiring to the same shared builder as the standalone memory-store bins.
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

import {
	type UnifiedArgs,
	buildUnified as buildMemoryStoreUnified,
} from "@melandlabs/memory-store/cli-shared";
import { parseOkfArgs, printOkfHelp, startOkf } from "@melandlabs/okf";
import { closeSQLiteVsaStore } from "@melandlabs/sqlite";
import { startHttpServer, startMcpServer } from "../index.js";
import { parseAddArgs, runAdd } from "./add.js";
import { parseDoctorArgs, runDoctor } from "./doctor.js";
import { parseListArgs, runList } from "./list.js";
import { parseSearchArgs, runSearch } from "./search.js";
import { parseStatsArgs, runStats } from "./stats.js";

interface HttpArgs extends UnifiedArgs {
	port: number;
	host: string;
}

interface McpArgs extends UnifiedArgs {
	name?: string;
	version?: string;
}

function unifiedFromEnv(env: NodeJS.ProcessEnv): UnifiedArgs {
	return {
		embeddingProvider: (env.EMBEDDING_PROVIDER as UnifiedArgs["embeddingProvider"] | undefined) ?? "none",
		embeddingModel: env.EMBEDDING_MODEL,
		embeddingCacheDir: env.LOCAL_EMBEDDING_CACHE_DIR,
		rerankerProvider:
			(env.RERANKER_PROVIDER as UnifiedArgs["rerankerProvider"] | undefined) ?? "none",
		rerankerModel: env.LOCAL_RERANKER_MODEL,
		rerankerCacheDir: env.LOCAL_RERANKER_CACHE_DIR,
		rerankerBatchSize: env.LOCAL_RERANKER_BATCH_SIZE
			? Number.parseInt(env.LOCAL_RERANKER_BATCH_SIZE, 10)
			: undefined,
		rerankerMaxTokens: env.LOCAL_RERANKER_MAX_TOKENS
			? Number.parseInt(env.LOCAL_RERANKER_MAX_TOKENS, 10)
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
			throw new Error(`${logPrefix} unknown flag: ${arg}`);
	}
}

function validateUnifiedArgs(args: UnifiedArgs, logPrefix: string): void {
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
	if (
		args.milvusDimension !== undefined &&
		(!Number.isInteger(args.milvusDimension) || args.milvusDimension <= 0)
	) {
		throw new Error(`${logPrefix} --milvus-dimension must be a positive integer`);
	}
	for (const [name, value] of [
		["--reranker-batch-size", args.rerankerBatchSize],
		["--reranker-max-tokens", args.rerankerMaxTokens],
	] as const) {
		if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
			throw new Error(`${logPrefix} ${name} must be a positive integer`);
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

async function buildUnified(args: UnifiedArgs) {
	return buildMemoryStoreUnified(args);
}

function printTopHelp(): void {
	console.log(`opencontext — single CLI for the OpenContext facade.

Usage:
  opencontext [command] [options]

Commands:
  mcp     Start the MCP server on stdio (default)
  http    Start the HTTP server
  add     Append a raw message to the active manager (no LLM roundtrip)
  search  Unified read with --mode {auto|lex|sem} and --context-only
  list    Browse raw messages by filter (newest first by default)
  stats   Report counts from the active raw-message store
  doctor  Run health checks against the local install
  okf     OKF v0.2 (Open Knowledge Format) importer / exporter

Run "opencontext <command> --help" for command-specific options.

Examples:
  opencontext
  opencontext mcp
  opencontext mcp --embedding-provider local --memory-backend sqlite-vec
  opencontext http
  opencontext http --port 8080
  opencontext add --user alice --text "Rust achieves memory safety without GC"
  opencontext search --user alice --query "memory safety" --k 5
  opencontext search --user alice --query "x" --context-only
  opencontext list --user alice --since 2026-08-01 --limit 20
  opencontext stats --json | jq '.stats.totalMessages'
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

Reranking (after RRF/source fusion, before final Top-K):
  --reranker-provider <name>      local | none (env: RERANKER_PROVIDER)
  --reranker-model <name>         Sequence-classification model
                                  (env: LOCAL_RERANKER_MODEL)
  --reranker-cache-dir <path>     Persistent model cache
                                  (env: LOCAL_RERANKER_CACHE_DIR)
  --reranker-batch-size <int>     Pair scoring batch size (default: 8)
  --reranker-max-tokens <int>     Query/document pair token limit (default: 512)

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

Examples:
  opencontext http
  opencontext http --port 8080

  # Local ONNX embedder + sqlite-vec ANN (no API key, no extra services).
  opencontext http --embedding-provider local --memory-backend sqlite-vec

  # Same as above + LLM reasoning (query-rewriter + iterative planner).
  # Reads OPENCONTEXT_LLM_API_KEY / OPENCONTEXT_LLM_BASE_URL /
  # OPENCONTEXT_LLM_MODEL from the environment so .env Just Works.
  # After this, POST /v1/search honors body.reasoningStrategy: rewrite|iterative.
  opencontext http \\
    --embedding-provider local \\
    --memory-backend sqlite-vec \\
    --reasoning

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

Reranking (after RRF/source fusion, before final Top-K):
  --reranker-provider <name>      local | none (env: RERANKER_PROVIDER)
  --reranker-model <name>         Sequence-classification model
                                  (env: LOCAL_RERANKER_MODEL)
  --reranker-cache-dir <path>     Persistent model cache
                                  (env: LOCAL_RERANKER_CACHE_DIR)
  --reranker-batch-size <int>     Pair scoring batch size (default: 8)
  --reranker-max-tokens <int>     Query/document pair token limit (default: 512)

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

Reasoning (wires unified.reasoning.{queryRewriter, iterativePlanner}):
  --reasoning                     Enable the LLM reasoning layer so memory.search
                                  can honor reasoningStrategy: 'rewrite' | 'iterative'.
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

Examples:
  # Default — all three *_not_configured warnings remain
  opencontext mcp

  # Local ONNX embedder + sqlite-vec ANN (no API key, no extra services)
  opencontext mcp --embedding-provider local --memory-backend sqlite-vec

  # Same as above + LLM reasoning (memory.search honors
  # reasoningStrategy: 'rewrite' | 'iterative'). Reads OPENCONTEXT_LLM_*
  # from the environment so .env Just Works.
  opencontext mcp \\
    --embedding-provider local \\
    --memory-backend sqlite-vec \\
    --reasoning

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
		// Mirror cli-mcp.ts — close the transport first, then drain the
		// SQLite stores so sqlite-vec's TLS mutex destructors don't race
		// in-flight queries during SIGTERM teardown.
		await server.close();
		try {
			await closeSQLiteVsaStore();
		} catch (error) {
			console.error("[opencontext/mcp] closeSQLiteVsaStore failed:", error);
		}
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

	if (head === "add" || head === "ADD") {
		process.exit(await runAdd(parseAddArgs(argv.slice(1))));
	}

	if (head === "search" || head === "SEARCH") {
		process.exit(await runSearch(parseSearchArgs(argv.slice(1))));
	}

	if (head === "list" || head === "LIST") {
		process.exit(await runList(parseListArgs(argv.slice(1))));
	}

	if (head === "stats" || head === "STATS") {
		process.exit(await runStats(parseStatsArgs(argv.slice(1))));
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
