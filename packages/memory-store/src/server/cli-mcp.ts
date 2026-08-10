#!/usr/bin/env node
/**
 * CLI entry for the memory-store MCP daemon.
 *
 * Usage:
 *   opencontext-memory-mcp
 *
 * Exposes the standalone memory store over MCP stdio. To enable
 * unified search, hosts must register a postgres factory via
 * `registerPostgresFactory(...)` before spawning this CLI.
 */

import { startMcpServer } from "../mcp";

async function main(): Promise<void> {
	const server = await startMcpServer();
	console.error("[memory-store/mcp] listening on stdio");

	const shutdown = async (signal: NodeJS.Signals) => {
		console.error(`[memory-store/mcp] ${signal} received, shutting down…`);
		await server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error("[memory-store/mcp] fatal:", error);
	process.exit(1);
});
