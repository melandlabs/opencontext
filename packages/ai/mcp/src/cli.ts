#!/usr/bin/env node

import { runOpenContextMcpStdioServer } from "./server";

async function main(): Promise<void> {
	await runOpenContextMcpStdioServer();
}

main().catch((error) => {
	const _message = error instanceof Error ? error.message : String(error);
	process.exit(1);
});
