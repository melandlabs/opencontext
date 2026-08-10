#!/usr/bin/env node

import { runOpenContextMcpStdioServer } from "./server";

async function main(): Promise<void> {
	await runOpenContextMcpStdioServer();
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[opencontext-mcp] ${message}`);
	process.exit(1);
});
