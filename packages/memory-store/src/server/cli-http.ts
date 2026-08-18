#!/usr/bin/env node
/**
 * CLI entry for the memory-store HTTP daemon.
 *
 * Usage:
 *   opencontext-memory-http --port 7421 --host 127.0.0.1
 *
 * Reads `MEMORY_HTTP_PORT` and `MEMORY_HTTP_HOST` env vars as defaults,
 * and additionally accepts flags (or env vars) to wire the four
 * `unified.*` deps that `/v1/search` consults: `embedQuery`,
 * `searchRawMessagesAnn`, `searchInsights`, `searchKnowledge`. With no
 * flags, the daemon preserves its historical minimal behavior —
 * `/v1/search` then carries three structured `*_not_configured`
 * warnings.
 *
 *   --port <port>                          MEMORY_HTTP_PORT  (default 7421)
 *   --host <host>                          MEMORY_HTTP_HOST  (default 127.0.0.1)
 *
 * `cli-shared.ts` owns the rest of the flag surface — see
 * `parseUnifiedArgs()` / `buildUnified()`. The `local` embedder and
 * every `chroma` backend dynamically import `@melandlabs/ai-rag` (a
 * peer install — pulling it in adds `@huggingface/transformers`,
 * `chromadb`, and ~30 MB of ONNX weights on first run). The bin errors
 * with a clear remediation message if the package is missing.
 *
 * For sqlite-vec to actually return hits, the messages you POST must
 * carry an `embedding` (or use `POST /v1/raw-messages` with
 * `embedOnInsert: true` plus an `--embedding-provider`).
 */

import type { UnifiedSearchDeps } from "../config";
import { startHttpServer } from "../http";
import { type UnifiedArgs, buildUnified, parseUnifiedArgs, printUnifiedHelp } from "./cli-shared";

interface HttpArgs extends UnifiedArgs {
	port: number;
	host: string;
}

function parseArgs(argv: string[]): HttpArgs {
	const env = process.env;
	const unified = parseUnifiedArgs(argv);
	const args: HttpArgs = {
		...unified,
		port: Number.parseInt(env.MEMORY_HTTP_PORT ?? "7421", 10),
		host: env.MEMORY_HTTP_HOST ?? "127.0.0.1",
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
			case "--port":
				args.port = Number.parseInt(takeValue(), 10);
				break;
			case "--host":
				args.host = takeValue();
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
		}
	}
	if (!Number.isFinite(args.port) || args.port <= 0) {
		throw new Error(`[memory-store/http] invalid --port: ${args.port}`);
	}
	return args;
}

function printHelp(): void {
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.log(`opencontext-memory-http — standalone memory-store HTTP daemon.

Usage:
  opencontext-memory-http [options]

Server:
  --port <port>                   Port to listen on (default: 7421, env: MEMORY_HTTP_PORT)
  --host <host>                   Host to bind (default: 127.0.0.1, env: MEMORY_HTTP_HOST)
`);
	printUnifiedHelp();
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.log(`
Examples:
  # Minimal — same as before, all three *not_configured warnings remain
  opencontext-memory-http

  # Local ONNX embedder + sqlite-vec ANN for the memory source (no API key,
  # no extra services). Removes embedQuery + memory warnings; the
  # insights/knowledge sources still need a backend of their own.
  opencontext-memory-http \\
    --embedding-provider local \\
    --memory-backend sqlite-vec

  # Wire everything via a running Chroma server
  opencontext-memory-http \\
    --embedding-provider openrouter \\
    --chroma-url http://127.0.0.1:8000 \\
    --memory-backend chroma \\
    --insights-backend chroma \\
    --knowledge-backend chroma`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const unified: UnifiedSearchDeps = await buildUnified(args);

	const { url, stop } = await startHttpServer({
		port: args.port,
		host: args.host,
		unified,
	});
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.log(`[memory-store/http] listening at ${url}`);

	const shutdown = async (signal: NodeJS.Signals) => {
		// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
		console.log(`[memory-store/http] ${signal} received, shutting down…`);
		await stop();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	// biome-ignore lint/suspicious/noConsole: intentional server/CLI logging
	console.error("[memory-store/http] fatal:", error);
	process.exit(1);
});
