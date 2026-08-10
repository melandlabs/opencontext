#!/usr/bin/env node
/**
 * CLI entry for the memory-store HTTP daemon.
 *
 * Usage:
 *   opencontext-memory-http --port 7421 --host 127.0.0.1
 *
 * Reads `MEMORY_HTTP_PORT` and `MEMORY_HTTP_HOST` env vars as
 * defaults. Wires up the standalone memory store (no Drizzle — only
 * sqlite-vec-backed reads are available).
 */

import { startHttpServer } from "../http";

interface CliArgs {
	port: number;
	host: string;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
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
		} else if (arg === "--help" || arg === "-h") {
			console.log("Usage: opencontext-memory-http [--port <port>] [--host <host>]");
			process.exit(0);
		}
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { url, port, stop } = await startHttpServer({
		port: args.port,
		host: args.host,
	});
	console.log(`[memory-store/http] listening at ${url}`);

	const shutdown = async (signal: NodeJS.Signals) => {
		console.log(`[memory-store/http] ${signal} received, shutting down…`);
		await stop();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error("[memory-store/http] fatal:", error);
	process.exit(1);
});
