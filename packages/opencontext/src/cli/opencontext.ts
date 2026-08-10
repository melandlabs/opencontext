#!/usr/bin/env node
/**
 * `opencontext` — single CLI entry that dispatches to the MCP or HTTP daemon.
 *
 * Subcommands:
 *   mcp    Start the MCP server on stdio (default when no subcommand given).
 *   http   Start the HTTP server (Hono) on the configured host/port.
 *
 * Usage:
 *   opencontext                  # default → MCP on stdio
 *   opencontext mcp              # explicit MCP
 *   opencontext http             # HTTP on default 127.0.0.1:7421
 *   opencontext http --port 8080 # HTTP on a custom port
 *
 * The HTTP daemon reads `MEMORY_HTTP_PORT` / `MEMORY_HTTP_HOST` as defaults.
 * Imports go through the facade's main bundle so every bin shares one
 * canonical copy of the runtime code.
 */

import { startHttpServer, startMcpServer } from "../index.js";

interface HttpArgs {
	port: number;
	host: string;
}

function parseHttpArgs(argv: string[]): HttpArgs {
	const args: HttpArgs = {
		port: Number.parseInt(process.env.MEMORY_HTTP_PORT ?? "7421", 10),
		host: process.env.MEMORY_HTTP_HOST ?? "127.0.0.1",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--port" && next) {
			args.port = Number.parseInt(next, 10);
			i += 1;
		} else if (arg === "--host" && next) {
			args.host = next;
			i += 1;
		}
	}
	return args;
}

function printHelp(): void {
	console.log(`opencontext — single CLI for the OpenContext facade.

Usage:
  opencontext [command] [options]

Commands:
  mcp    Start the MCP server on stdio (default)
  http   Start the HTTP server

Options (http only):
  --port <port>    Port to listen on (default: 7421, env: MEMORY_HTTP_PORT)
  --host <host>    Host to bind (default: 127.0.0.1, env: MEMORY_HTTP_HOST)

Examples:
  opencontext                  # MCP on stdio
  opencontext mcp              # same
  opencontext http             # HTTP on default port
  opencontext http --port 8080 # HTTP on a custom port`);
}

async function startMcp(): Promise<void> {
	const server = await startMcpServer();
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
	const { port, host } = parseHttpArgs(argv);
	const { url, stop } = await startHttpServer({ port, host });
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
		await startMcp();
		return;
	}

	if (head === "http" || head === "HTTP") {
		await startHttp(argv.slice(1));
		return;
	}

	if (head === "--help" || head === "-h") {
		printHelp();
		return;
	}

	console.error(`[opencontext] unknown command: ${head}`);
	printHelp();
	process.exit(1);
}

main().catch((error) => {
	console.error("[opencontext] fatal:", error);
	process.exit(1);
});
