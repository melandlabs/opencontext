#!/usr/bin/env node
/**
 * CLI entry for the memory-store MCP daemon.
 *
 * Usage:
 *   opencontext-memory-mcp
 *
 * Spawns an MCP server over stdio exposing the memory-store tools
 * (`memory-searchUnified`, `memory-writeRawMessage`,
 * `memory-getRawMessage`, `memory-health`). With no flags, every
 * `searchUnified` call returns three structured `*_not_configured`
 * warnings — pass the same flag surface as `opencontext-memory-http`
 * to wire the four `unified.*` deps.
 *
 *   --name <name>                          Server name surfaced to MCP clients (env: MEMORY_MCP_NAME)
 *   --version <version>                    Server version surfaced to MCP clients (env: MEMORY_MCP_VERSION)
 *
 * The `local` embedder and every `chroma` backend dynamically import
 * `@melandlabs/ai-rag` (a peer install) — see `cli-shared.ts` for the
 * full unified-flag surface.
 */

import type { UnifiedSearchDeps } from "../config";
import { startMcpServer } from "../mcp";
import { type UnifiedArgs, buildUnified, parseUnifiedArgs, printUnifiedHelp } from "./cli-shared";

interface McpArgs extends UnifiedArgs {
	name?: string;
	version?: string;
}

function parseArgs(argv: string[]): McpArgs {
	const env = process.env;
	const unified = parseUnifiedArgs(argv);
	const args: McpArgs = {
		...unified,
		name: env.MEMORY_MCP_NAME,
		version: env.MEMORY_MCP_VERSION,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const takeValue = () => {
			if (next === undefined) throw new Error(`[memory-store/mcp] ${arg} requires a value`);
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
				printHelp();
				process.exit(0);
		}
	}
	return args;
}

function printHelp(): void {
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.log(`opencontext-memory-mcp — standalone memory-store MCP daemon.

Usage:
  opencontext-memory-mcp [options]

Server identity (advertised to MCP clients):
  --name <name>                   Server name (env: MEMORY_MCP_NAME)
  --version <version>             Server version (env: MEMORY_MCP_VERSION)
`);
	printUnifiedHelp();
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.log(`
Examples:
  # Minimal — same as before, all three *not_configured warnings remain
  opencontext-memory-mcp

  # Local ONNX embedder + sqlite-vec ANN for the memory source
  opencontext-memory-mcp \\
    --embedding-provider local \\
    --memory-backend sqlite-vec

  # Wire everything via a running Chroma server
  opencontext-memory-mcp \\
    --embedding-provider openrouter \\
    --chroma-url http://127.0.0.1:8000 \\
    --memory-backend chroma \\
    --insights-backend chroma \\
    --knowledge-backend chroma`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const unified: UnifiedSearchDeps = await buildUnified(args);

	const server = await startMcpServer({
		unified,
		name: args.name,
		version: args.version,
	});
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.error("[memory-store/mcp] listening on stdio");

	const shutdown = async (signal: NodeJS.Signals) => {
		// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
		console.error(`[memory-store/mcp] ${signal} received, shutting down…`);
		await server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.error("[memory-store/mcp] fatal:", error);
	process.exit(1);
});
