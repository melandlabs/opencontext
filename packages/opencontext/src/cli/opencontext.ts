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
	applyUnifiedFlag,
	buildUnified as buildMemoryStoreUnified,
	printUnifiedHelp,
	unifiedArgsFromEnv as unifiedFromEnv,
	validateUnifiedArgs,
} from "@melandlabs/memory-store/cli-shared";
import { parseOkfArgs, printOkfHelp, startOkf } from "@melandlabs/okf";
import { closeSQLiteVsaStore } from "@melandlabs/sqlite";
// Workspace CLI is shipped as an optional subpath import so a host
// that doesn't install `@melandlabs/workspace` still gets a usable
// `opencontext` CLI without crashing the bootstrap.
import { runWorkspaceCli } from "@melandlabs/workspace/cli";
import { startHttpServer, startMcpServer } from "../index.js";
import { parseAddArgs, runAdd } from "./add.js";
import { parseDeprecateArgs, runDeprecate } from "./deprecate.js";
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
				if (!applyUnifiedFlag(args, arg, takeValue)) throw new Error(`${logPrefix} unknown flag: ${arg}`);
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
				if (!applyUnifiedFlag(args, arg, takeValue)) throw new Error(`${logPrefix} unknown flag: ${arg}`);
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
  mcp        Start the MCP server on stdio (default)
  http       Start the HTTP server
  add        Append a raw message to the active manager (no LLM roundtrip)
  deprecate  Soft-deprecate raw messages (supersession: hide from search
             unless --include-deprecated is set; record --reason and
             --superseded-by for the chain)
  search     Unified read with --mode {auto|lex|sem} and --context-only
  list       Browse raw messages by filter (newest first by default)
  stats      Report counts from the active raw-message store
  doctor     Run health checks against the local install
  okf        OKF v0.2 (Open Knowledge Format) importer / exporter
  workspace  Versioned, cross-file folder knowledge

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
  opencontext deprecate --user alice --id <old-id> --reason "superseded" --superseded-by <new-id>
  opencontext search --user alice --query "memory safety" --include-deprecated --json
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
`);
	printUnifiedHelp();
	console.log(`
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
`);
	printUnifiedHelp();
	console.log(`
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

	if (head === "deprecate" || head === "DEPRECATE") {
		process.exit(await runDeprecate(parseDeprecateArgs(argv.slice(1))));
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

	if (head === "workspace" || head === "WORKSPACE") {
		const exit = await runWorkspaceCli(argv.slice(1));
		process.exit(exit);
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
