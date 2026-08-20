/**
 * `opencontext add` — append a single raw message directly to the active
 * raw-message manager. Bypasses the agentic `consolidate()` loop so this
 * is a fast, deterministic, no-LLM-roundtrip write — useful for CLI
 * backfills, scripted ingestion, and ad-hoc captures that you intend to
 * let `consolidate` pick up later.
 *
 * Inspired by memvid's `put`: same "one command, write one thing" UX,
 * but mapped onto opencontext's raw-message shape (id + platform + bot
 * + timestamp + content + metadata) instead of memvid's flat frame.
 *
 * Auto-filled fields (when the user omits them):
 *   - `userId`      — "default" if `--user` not given (single-tenant
 *                     convenience; multi-user hosts should always
 *                     pass `--user <id>` explicitly to avoid
 *                     cross-tenant writes)
 *   - `messageId`   — `crypto.randomUUID()`
 *   - `platform`    — "cli" (distinguishes CLI-originated rows from
 *                     ingestion from Slack/Discord/etc.)
 *   - `botId`       — "default" if `--bot` not given
 *   - `timestamp`   — `Date.now()` if `--at` not given
 *
 * Exit codes:
 *   0 — wrote at least one row
 *   1 — validation error, missing field, or backend refused the write
 *
 * Output:
 *   Default: human-friendly single line, e.g.
 *     wrote 1 message: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
 *   `--json`:
 *     { "ok": true, "ids": [...], "count": 1, "platform": "cli", "exit": 0 }
 */

import { randomUUID } from "node:crypto";

import { getRawMessageManager } from "@melandlabs/memory-store";

export interface AddOptions {
	userId: string;
	botId: string;
	text: string;
	kind?: string;
	source?: string;
	platform?: string;
	at?: string;
	tags: Record<string, string>;
	channel?: string;
	person?: string;
	json?: boolean;
}

export interface AddOutput {
	ok: boolean;
	exit: number;
	count: number;
	ids: number[];
	platform: string;
	error?: string;
}

const logPrefix = "[opencontext/add]";

export function parseAddArgs(argv: string[]): AddOptions {
	const opts: AddOptions = {
		userId: "",
		botId: "default",
		text: "",
		tags: {},
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
			case "--bot":
				opts.botId = take();
				break;
			case "--text":
				opts.text = take();
				break;
			case "--source":
				opts.source = take();
				break;
			case "--kind":
				opts.kind = take();
				break;
			case "--platform":
				opts.platform = take();
				break;
			case "--at":
				opts.at = take();
				break;
			case "--channel":
				opts.channel = take();
				break;
			case "--person":
				opts.person = take();
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				printAddHelp();
				process.exit(0);
				break;
			default:
				if (arg.startsWith("--tag=")) {
					const kv = arg.slice("--tag=".length);
					const eq = kv.indexOf("=");
					if (eq <= 0) {
						throw new Error(`${logPrefix} --tag expects key=value (got "${arg}")`);
					}
					opts.tags[kv.slice(0, eq)] = kv.slice(eq + 1);
				} else if (arg === "--tag") {
					const kv = take();
					const eq = kv.indexOf("=");
					if (eq <= 0) {
						throw new Error(`${logPrefix} --tag expects key=value (got "${kv}")`);
					}
					opts.tags[kv.slice(0, eq)] = kv.slice(eq + 1);
				} else {
					throw new Error(`${logPrefix} unknown flag: ${arg}`);
				}
		}
	}

	if (!opts.userId) {
		// Default to a single shared tenant when the flag is omitted —
		// mirrors how `--bot` falls back to "default". Multi-user hosts
		// should still pass `--user <id>` explicitly to avoid cross-tenant
		// writes.
		opts.userId = "default";
	}
	if (!opts.text) {
		throw new Error(`${logPrefix} --text <text> is required`);
	}
	if (opts.at !== undefined) {
		// Validate up-front so parseAddArgs fails fast (matches the
		// `--since/--until` pattern in parseSearchArgs).
		parseTimestamp(opts.at);
	}
	return opts;
}

export async function runAdd(opts: AddOptions): Promise<number> {
	const platform = opts.platform ?? "cli";
	const timestamp = parseTimestamp(opts.at) ?? Date.now();
	const messageId = randomUUID();

	const metadata: Record<string, unknown> = { ...opts.tags };
	if (opts.source) metadata.source = opts.source;
	if (opts.kind) metadata.kind = opts.kind;

	const message = {
		messageId,
		platform,
		botId: opts.botId,
		userId: opts.userId,
		channel: opts.channel,
		person: opts.person,
		timestamp,
		content: opts.text,
		createdAt: Date.now(),
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};

	const manager = await getRawMessageManager();
	if (typeof manager.storeMessages !== "function") {
		return emit(
			opts,
			{
				ok: false,
				exit: 1,
				count: 0,
				ids: [],
				platform,
				error: "active raw-message manager exposes no storeMessages",
			},
			"error: active raw-message manager exposes no storeMessages",
		);
	}

	const ids = await manager.storeMessages([message]);
	const out: AddOutput = {
		ok: true,
		exit: 0,
		count: ids.length,
		ids,
		platform,
	};
	return emit(opts, out, `wrote ${ids.length} message${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
}

function parseTimestamp(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) {
		throw new Error(`${logPrefix} --at expects an ISO-8601 timestamp (got "${value}")`);
	}
	return parsed;
}

function emit(opts: AddOptions, out: AddOutput, humanLine: string): number {
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(out)}\n`);
	} else {
		process.stdout.write(`${humanLine}\n`);
	}
	return out.exit;
}

function printAddHelp(): void {
	console.log(`opencontext add — append a raw message directly to the active manager.

Usage:
  opencontext add [options]

Required:
  --text <text>              Message content

Identity:
  --user <id>                User / workspace id (default: "default")
  --bot <id>                 Bot id (default: "default")
  --platform <name>          Origin platform tag (default: "cli")
  --channel <name>           Optional channel label
  --person <id>              Optional person / author id

Provenance:
  --source <uri>             Source URI (stored in metadata.source)
  --kind <factType>          Memory kind, e.g. "world" | "experience" |
                             "mental_model" (stored in metadata.kind)
  --at <iso-8601>            Timestamp override (default: now)
  --tag <key=value>          Free-form tag (repeatable, also accepts --tag=k=v)

Output:
  --json                     Emit JSON envelope instead of a human line

Examples:
  # Minimal — just a user and some text
  opencontext add --user alice --text "Rust achieves memory safety without GC"

  # Full provenance for later consolidation
  opencontext add \\
    --user alice --bot general \\
    --text "Discussed Q4 roadmap with the team" \\
    --source "meeting://2026-08-20" --kind "experience" \\
    --tag "topic=roadmap" --tag "team=eng"

  # Script-friendly
  opencontext add --user alice --text "..." --json`);
}
