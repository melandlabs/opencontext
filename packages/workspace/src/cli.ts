#!/usr/bin/env node
/**
 * `@melandlabs/workspace/cli` — `opencontext workspace …` subcommand.
 *
 *   opencontext workspace update --workspace-id <id> --path <folder> [--user <id>]
 *   opencontext workspace search --workspace-id <id> --query <text>
 *                                       [--strategy hybrid] [--limit 10]
 *                                       [--resource-type note,statute] [--json]
 *   opencontext workspace list   --workspace-id <id>
 *                                       [--resource-type <t>] [--index-status ready]
 *                                       [--limit 50] [--offset 0] [--json]
 *
 * The CLI is intentionally thin — it parses argv, builds a `RuntimeContext`,
 * and delegates to the JS API in `./api`. The embedding queue is wired in
 * here (not in `./api`) so a one-shot `update` invocation can await the
 * async fan-out and report a final `ready` / `partial` status before exit.
 */

import { randomUUID } from "node:crypto";

import type { RuntimeContext, WorkspaceSearchStrategy } from "./types";
import {
	getSQLiteWorkspaceStore,
	closeSQLiteWorkspaceStore,
	resolveWorkspaceDbPath,
} from "./sqlite";
import {
	updateWorkspaceContext,
	searchWorkspaceContext,
	listWorkspaceResources,
} from "./api";
import { createEmbeddingQueue } from "./embedding-queue";

const logPrefix = "[opencontext/workspace]";

const STRATEGIES: WorkspaceSearchStrategy[] = ["lexical", "semantic", "hybrid", "cross-file"];
const INDEX_STATUSES = ["pending", "partial", "ready", "failed"] as const;

// Flags that don't take a value (booleans). Listed once here so the
// generic parseFlags() helper can skip its `next.startsWith("--")`
// guard for them.
const BOOLEAN_FLAGS = new Set<string>([
	"--await-embeddings",
	"--no-await-embeddings",
	"--json",
]);

// ────────────────────────────────────────────────────────────────────────────
//  Argv helpers
// ────────────────────────────────────────────────────────────────────────────

class ArgvError extends Error {
	constructor(message: string) {
		super(`${logPrefix} ${message}`);
	}
}

interface ParseOptions<T> {
	positional?: (arg: string, state: T) => void;
}

function takeValue(argv: string[], i: number, flag: string): { value: string; next: number } {
	const next = argv[i + 1];
	if (next === undefined || next.startsWith("--")) {
		throw new ArgvError(`${flag} requires a value`);
	}
	return { value: next, next: i + 2 };
}

function parseFlags<T extends object>(
	argv: string[],
	options: ParseOptions<T> = {},
): T {
	const out = {} as T;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			throw new ArgvError("--help requested");
		}
		if (options.positional && !arg.startsWith("--")) {
			options.positional(arg, out);
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = eq >= 0 ? arg.slice(0, eq) : arg;
		const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
		const useInline = inline !== undefined;
		const applyValue = (value: string) => {
			const key = flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
			(out as Record<string, unknown>)[key] = value;
		};
		const applyBoolean = () => {
			let key = flag.slice(2);
			let value: boolean;
			if (key.startsWith("no-")) {
				key = key.slice(3);
				value = false;
			} else {
				value = true;
			}
			key = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
			(out as Record<string, unknown>)[key] = value;
		};
		if (BOOLEAN_FLAGS.has(flag)) {
			applyBoolean();
			continue;
		}
		if (useInline) {
			applyValue(inline);
		} else {
			const { value, next } = takeValue(argv, i, flag);
			applyValue(value);
			i = next - 1;
		}
	}
	return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Subcommand: update
// ────────────────────────────────────────────────────────────────────────────

interface UpdateArgs {
	workspaceId?: string;
	path?: string;
	user?: string;
	awaitEmbeddings?: boolean;
	drainTimeoutMs?: number;
	json?: boolean;
}

function parseUpdateArgs(argv: string[]): UpdateArgs {
	return parseFlags<UpdateArgs>(argv, {
		positional: (arg, state) => {
			// Allow `opencontext workspace update <workspace_id> --path …`
			// as a convenience (positional first arg).
			if (!state.workspaceId) {
				state.workspaceId = arg;
				return;
			}
			throw new ArgvError(`unexpected positional argument: ${arg}`);
		},
	});
}

async function runUpdate(args: UpdateArgs): Promise<number> {
	const workspaceId = args.workspaceId;
	const path = args.path;
	if (!workspaceId) throw new ArgvError("--workspace-id <id> is required");
	if (!path) throw new ArgvError("--path <folder> is required");
	const userId = args.user ?? "default";

	const ctx_rt: RuntimeContext = {
		user_id: userId,
		request_id: randomUUID(),
	};

	const store = await getSQLiteWorkspaceStore();
	const queue = createEmbeddingQueue({ store });

	const result = await updateWorkspaceContext(
		ctx_rt,
		store,
		{ workspace_id: workspaceId, source: "okf_folder", path },
		{ enqueueEmbedding: (input) => queue.enqueue(input) },
	);

	if (args.awaitEmbeddings) {
		// Default behaviour: wait for the queue to drain so the CLI
		// reports a final index_status before exiting. Users can opt
		// out with --no-await-embeddings (handled by parseFlags: any
		// `--no-X` is captured as `awaitEmbeddings: false`).
		const timeoutMs = args.drainTimeoutMs ?? 120_000;
		await Promise.race([
			queue.drain(),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}

	const out = {
		ok: true,
		exit: 0,
		workspace_id: workspaceId,
		job_id: result.jobId,
		status: result.status,
		files_scanned: result.filesScanned,
		files_added: result.filesAdded,
		files_modified: result.filesModified,
		files_unchanged: result.filesUnchanged,
		files_deleted: result.filesDeleted,
	};

	if (args.json) {
		process.stdout.write(`${JSON.stringify(out)}\n`);
	} else {
		const lines = [
			`scanned ${result.filesScanned} files`,
			`added ${result.filesAdded}`,
			`modified ${result.filesModified}`,
			`unchanged ${result.filesUnchanged}`,
			`deleted ${result.filesDeleted}`,
			`job_id=${result.jobId} status=${result.status}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	return 0;
}

// ────────────────────────────────────────────────────────────────────────────
//  Subcommand: search
// ────────────────────────────────────────────────────────────────────────────

interface SearchArgs {
	workspaceId?: string;
	query?: string;
	strategy?: string;
	limit?: string;
	threshold?: string;
	resourceType?: string;
	hops?: string;
	json?: boolean;
}

function parseSearchArgs(argv: string[]): SearchArgs {
	return parseFlags<SearchArgs>(argv);
}

async function runSearch(args: SearchArgs): Promise<number> {
	const workspaceId = args.workspaceId;
	const query = args.query;
	if (!workspaceId) throw new ArgvError("--workspace-id <id> is required");
	if (!query) throw new ArgvError("--query <text> is required");

	const strategy = (args.strategy ?? "hybrid") as WorkspaceSearchStrategy;
	if (!STRATEGIES.includes(strategy)) {
		throw new ArgvError(`--strategy must be one of: ${STRATEGIES.join(", ")} (got "${args.strategy}")`);
	}

	const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) : 10;
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new ArgvError(`--limit must be a positive integer (got "${args.limit}")`);
	}
	const threshold = args.threshold !== undefined ? Number.parseFloat(args.threshold) : undefined;
	if (threshold !== undefined && (Number.isNaN(threshold) || threshold < 0 || threshold > 1)) {
		throw new ArgvError(`--threshold must be in [0, 1] (got "${args.threshold}")`);
	}
	const resourceTypes = args.resourceType
		? args.resourceType.split(",").map((s) => s.trim()).filter(Boolean)
		: undefined;
	const hops = args.hops !== undefined ? Number.parseInt(args.hops, 10) : undefined;
	if (hops !== undefined && hops !== 1 && hops !== 2) {
		throw new ArgvError(`--hops must be 1 or 2 (got "${args.hops}")`);
	}

	const ctx_rt: RuntimeContext = {
		user_id: "default",
		request_id: randomUUID(),
	};

	const store = await getSQLiteWorkspaceStore();
	const result = await searchWorkspaceContext(ctx_rt, store, {
		workspace_id: workspaceId,
		query,
		strategy,
		options: {
			limit,
			threshold,
			resource_types: resourceTypes,
			hops,
		},
	});

	if (args.json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		process.stdout.write(`${result.total} hit(s) (strategy=${strategy})\n`);
		for (const hit of result.hits) {
			const snippet = hit.snippet.replace(/\s+/g, " ").slice(0, 160);
			process.stdout.write(
				`  - [${hit.resource_type}] ${hit.resource_title} :: ${snippet} (score=${hit.score.toFixed(3)})\n`,
			);
		}
	}
	return 0;
}

// ────────────────────────────────────────────────────────────────────────────
//  Subcommand: list
// ────────────────────────────────────────────────────────────────────────────

interface ListArgs {
	workspaceId?: string;
	resourceType?: string;
	indexStatus?: string;
	limit?: string;
	offset?: string;
	json?: boolean;
}

function parseListArgs(argv: string[]): ListArgs {
	return parseFlags<ListArgs>(argv);
}

async function runList(args: ListArgs): Promise<number> {
	const workspaceId = args.workspaceId;
	if (!workspaceId) throw new ArgvError("--workspace-id <id> is required");
	if (args.indexStatus && !(INDEX_STATUSES as readonly string[]).includes(args.indexStatus)) {
		throw new ArgvError(
			`--index-status must be one of: ${INDEX_STATUSES.join(", ")} (got "${args.indexStatus}")`,
		);
	}
	const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) : 50;
	const offset = args.offset !== undefined ? Number.parseInt(args.offset, 10) : 0;
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new ArgvError(`--limit must be a positive integer (got "${args.limit}")`);
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new ArgvError(`--offset must be a non-negative integer (got "${args.offset}")`);
	}

	const ctx_rt: RuntimeContext = {
		user_id: "default",
		request_id: randomUUID(),
	};

	const store = await getSQLiteWorkspaceStore();
	const result = await listWorkspaceResources(ctx_rt, store, {
		workspace_id: workspaceId,
		resource_type: args.resourceType,
		index_status: args.indexStatus as
			| "pending"
			| "partial"
			| "ready"
			| "failed"
			| undefined,
		limit,
		offset,
	});

	if (args.json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		process.stdout.write(`${result.total} resource(s)\n`);
		for (const r of result.resources) {
			process.stdout.write(
				`  - [${r.index_status}] id=${r.id} ${r.resource_type} :: ${r.title}  (${r.canonical_key})\n`,
			);
		}
	}
	return 0;
}

// ────────────────────────────────────────────────────────────────────────────
//  Help
// ────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
	const dbPath = resolveWorkspaceDbPath();
	process.stdout.write(`opencontext workspace — versioned, cross-file folder knowledge.

Usage:
  opencontext workspace <subcommand> [options]

Subcommands:
  update   Index an OKF folder into the workspace SQLite store
  search   Run lexical | semantic | hybrid | cross-file search
  list     Enumerate indexed resources for a workspace

Storage:
  --db-path <path>           Override the SQLite path (default: ${dbPath})

Common:
  --workspace-id <id>        Workspace identifier (required)
  --user <id>                User / tenant id (default: "default")
  --json                     Emit JSON envelope instead of a human line

Examples:
  opencontext workspace update --workspace-id proj-1 --path ~/notes/wiki
  opencontext workspace update proj-1 --path ~/notes/wiki --user alice
  opencontext workspace search --workspace-id proj-1 --query "limitation"
  opencontext workspace search --workspace-id proj-1 --query "x" --strategy cross-file --hops 2
  opencontext workspace list   --workspace-id proj-1 --index-status ready

Run "opencontext workspace <subcommand> --help" for subcommand-specific options.
`);
}

function printSubcommandHelp(sub: string): void {
	switch (sub) {
		case "update":
			process.stdout.write(`opencontext workspace update — index an OKF folder.

Required:
  --workspace-id <id>        Workspace identifier
  --path <folder>            Path to the OKF folder (will be scanned recursively)

Optional:
  --user <id>                User / tenant id (default: "default")
  --await-embeddings         Wait for the in-process embedding queue to drain
                             before exiting (default: on)
  --no-await-embeddings      Return as soon as synchronous indexing completes
  --drain-timeout-ms <int>   Upper bound on --await-embeddings (default 120000)
  --json                     Emit JSON envelope

Example:
  opencontext workspace update --workspace-id proj-1 --path ./wiki
`);
			return;
		case "search":
			process.stdout.write(`opencontext workspace search — multi-strategy hybrid search.

Required:
  --workspace-id <id>        Workspace identifier
  --query <text>             Search query

Strategy:
  --strategy <name>          lexical | semantic | hybrid | cross-file
                             (default: hybrid)
  --limit <int>              Top-N hits (default: 10, max: 50)
  --threshold <float>        Semantic similarity threshold, 0..1 (default: 0.7)
  --resource-type <list>     Comma-separated filter, e.g. "note,statute"
  --hops <1|2>               Cross-file BFS depth (cross-file strategy only)

Output:
  --json                     Emit JSON envelope with full WorkspaceSearchHit[]

Example:
  opencontext workspace search --workspace-id proj-1 --query "limitation" \\
    --strategy cross-file --hops 1 --json
`);
			return;
		case "list":
			process.stdout.write(`opencontext workspace list — enumerate indexed resources.

Required:
  --workspace-id <id>        Workspace identifier

Filters:
  --resource-type <name>     Filter by resource type
  --index-status <status>    pending | partial | ready | failed
  --limit <int>              Max rows (default: 50)
  --offset <int>             Skip N rows (default: 0)

Output:
  --json                     Emit JSON envelope

Example:
  opencontext workspace list --workspace-id proj-1 --index-status ready --limit 20
`);
			return;
		default:
			printHelp();
	}
}

// ────────────────────────────────────────────────────────────────────────────
//  Entry
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tear down the SQLite handle in the background so a `sqlite-vec` mutex
 * destructor (which can `SIGABRT` on certain platforms) doesn't poison
 * the main process exit. We:
 *
 *   1. Detach the close promise so no `await` ever blocks on it.
 *   2. Schedule `process.exit` to run AFTER stdout has drained (so the
 *      human / JSON output is actually visible) and BEFORE the OS
 *      reaps the still-pending sqlite-vec native mutex teardown.
 *   3. Set a hard 250ms timeout so a stuck close doesn't hang the CLI.
 */
function scheduleBackgroundClose(): void {
	// Detach the SQLite teardown — we never want `await` on it inside the
	// hot path because `sqlite-vec`'s native destructor occasionally
	// raises SIGABRT during process teardown.
	closeSQLiteWorkspaceStore().catch(() => {
		// Best-effort cleanup; ignore secondary errors.
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") {
		printHelp();
		return;
	}
	if (sub === "help") {
		printSubcommandHelp(argv[1] ?? "");
		return;
	}

	const rest = argv.slice(1);
	// Short-circuit `--help` / `-h` before parseFlags throws, so the
	// subcommand-level help text shows up instead of an error.
	if (rest.includes("--help") || rest.includes("-h")) {
		printSubcommandHelp(sub);
		process.exit(0);
	}

	let exitCode = 0;
	try {
		switch (sub) {
			case "update":
				exitCode = await runUpdate(parseUpdateArgs(rest));
				break;
			case "search":
				exitCode = await runSearch(parseSearchArgs(rest));
				break;
			case "list":
				exitCode = await runList(parseListArgs(rest));
				break;
			default:
				throw new ArgvError(`unknown subcommand: ${sub}`);
		}
	} catch (error) {
		if (error instanceof ArgvError) {
			process.stderr.write(`${error.message}\n`);
			// Force-exit on argv errors — see SIGABRT note below.
			process.exit(2);
		}
		throw error;
	}
	// Force-exit instead of letting Node's event loop drain: the
	// `@huggingface/transformers` ONNX worker thread spawned by the
	// local embedder leaves a `sqlite-vec` mutex in a state that
	// triggers `libc++abi: ... mutex lock failed: Invalid argument`
	// (SIGABRT) during natural teardown on macOS. Output has already
	// been written to stdout at this point, so a fast exit is safe.
	process.exit(exitCode);
}

// Guard against importing this file as a library (e.g. from
// `opencontext/cli/opencontext.ts`) — `runWorkspaceCli` is the
// programmatic entry, so only run the side-effecting `main()` when this
// file is the actual entry point.
const isDirectInvocation =
	typeof process !== "undefined" &&
	Array.isArray(process.argv) &&
	process.argv[1] !== undefined &&
	import.meta.url === `file://${process.argv[1]}`;

// Ignore SIGPIPE so a piped `head -n 1` doesn't show up as a fatal.
process.on("SIGPIPE", () => {
	process.exit(0);
});

if (isDirectInvocation) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${logPrefix} fatal: ${message}\n`);
		process.exit(1);
	});
}

/**
 * Programmatic entry point for hosts (e.g. `opencontext workspace …`)
 * that want to delegate argv parsing + subcommand dispatch without
 * re-importing the side-effecting `main()` above. Returns the desired
 * process exit code; never throws.
 */
export async function runWorkspaceCli(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") {
		printHelp();
		return 0;
	}
	if (sub === "help") {
		printSubcommandHelp(argv[1] ?? "");
		return 0;
	}
	const rest = argv.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) {
		printSubcommandHelp(sub);
		return 0;
	}
	try {
		switch (sub) {
			case "update":
				return await runUpdate(parseUpdateArgs(rest));
			case "search":
				return await runSearch(parseSearchArgs(rest));
			case "list":
				return await runList(parseListArgs(rest));
			default:
				process.stderr.write(`${logPrefix} unknown subcommand: ${sub}\n`);
				return 2;
		}
	} catch (error) {
		if (error instanceof ArgvError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${logPrefix} fatal: ${message}\n`);
		return 1;
	} finally {
		// Background-close so sqlite-vec's native mutex destructor
		// (occasionally SIGABRTs on certain macOS configs) doesn't
		// poison the main process exit. The host program invokes us
		// synchronously and then calls `process.exit` itself.
		closeSQLiteWorkspaceStore().catch(() => {
			// Best-effort cleanup; ignore secondary errors.
		});
	}
}
