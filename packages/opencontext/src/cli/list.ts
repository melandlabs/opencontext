/**
 * `opencontext list` — browse raw messages in reverse-chronological order
 * (or any order you want). Modelled after memvid's `timeline`: same "give
 * me the rows" ergonomics, mapped onto `RawMessageQuery` instead of a
 * flat frame index.
 *
 * Filtering surfaces:
 *   --user, --platform, --bot, --channel   (forwarded verbatim)
 *   --since / --until                       (ISO-8601, converted to ms)
 *   --limit / --offset                      (pagination)
 *   --reverse                               (ascending instead of default
 *                                            descending by timestamp)
 *
 * Exit codes:
 *   0 — query ran (zero results is still success)
 *   1 — validation error or backend threw
 *
 * Output:
 *   default        per-message line, oldest/newest first depending on --reverse
 *   --json         full envelope { ok, exit, count, results, query }
 */

import { getRawMessageManager } from "@melandlabs/memory-store";
import type { RawMessage } from "@melandlabs/memory-store";

// `RawMessageQuery` lives in `@melandlabs/indexeddb` and isn't re-exported
// by `@melandlabs/memory-store` yet. We mirror the subset the CLI uses
// here; any upstream additions we don't touch are simply ignored.
export interface RawMessageQuery {
	userId?: string;
	platform?: string;
	botId?: string;
	channel?: string;
	startTime?: number;
	endTime?: number;
	limit?: number;
	offset?: number;
	reverse?: boolean;
}

export interface ListOptions {
	userId: string;
	platform?: string;
	botId?: string;
	channel?: string;
	since?: string;
	until?: string;
	limit: number;
	offset: number;
	reverse: boolean;
	json: boolean;
}

export interface ListEnvelope {
	ok: boolean;
	exit: number;
	count: number;
	query: RawMessageQuery;
	results: RawMessage[];
	error?: string;
}

const logPrefix = "[opencontext/list]";

export function parseListArgs(argv: string[]): ListOptions {
	const opts: ListOptions = {
		userId: "default",
		limit: 20,
		offset: 0,
		reverse: false,
		json: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const take = () => {
			if (next === undefined) {
				throw new Error(`${logPrefix} ${arg} requires a value`);
			}
			i += 1;
			return next;
		};

		switch (arg) {
			case "--user":
				opts.userId = take();
				break;
			case "--platform":
				opts.platform = take();
				break;
			case "--bot":
				opts.botId = take();
				break;
			case "--channel":
				opts.channel = take();
				break;
			case "--since":
				opts.since = take();
				break;
			case "--until":
				opts.until = take();
				break;
			case "--limit":
			case "-n":
				opts.limit = Number.parseInt(take(), 10);
				break;
			case "--offset":
				opts.offset = Number.parseInt(take(), 10);
				break;
			case "--reverse":
				opts.reverse = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				printListHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`${logPrefix} unknown flag: ${arg}`);
		}
	}

	if (!opts.userId) {
		opts.userId = "default";
	}
	if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
		throw new Error(`${logPrefix} --limit must be a positive integer (got "${opts.limit}")`);
	}
	if (!Number.isFinite(opts.offset) || opts.offset < 0) {
		throw new Error(`${logPrefix} --offset must be >= 0 (got "${opts.offset}")`);
	}
	for (const date of [opts.since, opts.until]) {
		if (date && Number.isNaN(Date.parse(date))) {
			throw new Error(`${logPrefix} --since/--until expect ISO-8601 (got "${date}")`);
		}
	}
	return opts;
}

export async function runList(opts: ListOptions): Promise<number> {
	const query: RawMessageQuery = {
		userId: opts.userId,
		platform: opts.platform,
		botId: opts.botId,
		channel: opts.channel,
		startTime: opts.since ? Date.parse(opts.since) : undefined,
		endTime: opts.until ? Date.parse(opts.until) : undefined,
		limit: opts.limit,
		offset: opts.offset,
		reverse: opts.reverse,
	};

	const manager = await getRawMessageManager();
	let results: RawMessage[];
	try {
		results = await manager.queryMessages(query);
	} catch (error) {
		const message = (error as Error).message;
		const env: ListEnvelope = {
			ok: false,
			exit: 1,
			count: 0,
			query,
			results: [],
			error: message,
		};
		process.stdout.write(`${opts.json ? JSON.stringify(env) : `error: ${message}`}\n`);
		return env.exit;
	}

	const env: ListEnvelope = { ok: true, exit: 0, count: results.length, query, results };
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(env)}\n`);
		return env.exit;
	}
	process.stdout.write(`${renderHuman(env)}\n`);
	return env.exit;
}

function renderHuman(env: ListEnvelope): string {
	if (env.results.length === 0) {
		return `(no messages for user=${env.query.userId})`;
	}
	const lines: string[] = [];
	lines.push(`# ${env.count} message${env.count === 1 ? "" : "s"} for user=${env.query.userId}`);
	for (const r of env.results) {
		const ts = new Date(r.timestamp).toISOString();
		const preview = r.content.replace(/\s+/g, " ").slice(0, 160);
		const ellipsis = preview.length === 160 ? "…" : "";
		const rowId = r.id === undefined ? "?" : `#${r.id}`;
		const chan = r.channel ? `/${r.channel}` : "";
		lines.push(`[${ts}] ${rowId} ${r.platform}/${r.botId}${chan}@${r.userId} — ${preview}${ellipsis}`);
		lines.push(`    messageId: ${r.messageId}`);
	}
	return lines.join("\n");
}

function printListHelp(): void {
	console.log(`opencontext list — browse raw messages by filter, newest first by default.

Usage:
  opencontext list [options]

Identity:
  --user <id>                User / workspace id (default: "default")
  --platform <name>          Filter to one platform (e.g. "cli", "slack")
  --bot <id>                 Filter to one bot
  --channel <name>           Filter to one channel

Time:
  --since <iso-8601>         Inclusive start (ms-resolution)
  --until <iso-8601>         Inclusive end

Pagination:
  --limit <int>              Max rows (default: 20, also -n)
  --offset <int>             Skip first N rows (default: 0)
  --reverse                  Ascending by timestamp instead of descending

Output:
  --json                     Emit JSON envelope instead of human lines

Examples:
  # Newest 20 for the default user
  opencontext list --limit 20

  # All cli-originated writes for alice in August
  opencontext list --user alice --platform cli --since 2026-08-01 --until 2026-08-31

  # Pagination
  opencontext list --limit 50 --offset 50 --json | jq '.results[].messageId'`);
}
