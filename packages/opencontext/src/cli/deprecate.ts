/**
 * `opencontext deprecate` — soft-deprecate one or more raw messages
 * directly via the active raw-message manager.
 *
 * Mirrors `opencontext add`'s shape (single-file CLI, JSON envelope on
 * `--json`, no LLM roundtrip) but writes `deprecated_at`,
 * `deprecation_reason`, and `superseded_by_summary_id` instead of
 * inserting new rows. This is the supersession primitive that lets
 * `search` return the current-truth version of a decision/fact: once
 * the older rows are deprecated, `search --limit 1` returns the
 * successor instead of tying on similarity and falling back to a
 * lex `(type, id)` tiebreaker.
 *
 * Idempotent — re-running with the same ids returns 0 affected rows
 * (the underlying SQL guards on `WHERE deprecated_at IS NULL`).
 *
 * Exit codes:
 *   0 — at least one row was deprecated (or all inputs were already deprecated, with --json reporting 0)
 *   1 — validation error, backend refused, or threw mid-call
 *
 * Output:
 *   default  human-readable line: "deprecated N message(s): id1, id2"
 *   --json   { ok, exit, count, ids, deprecatedAt, reason?, supersededBySummaryId? }
 */

import { getRawMessageManager } from "@melandlabs/memory-store";

export interface DeprecateOptions {
	userId: string;
	ids: string[];
	reason?: string;
	supersededBySummaryId?: string;
	json: boolean;
}

export interface DeprecateOutput {
	ok: boolean;
	exit: number;
	count: number;
	ids: string[];
	deprecatedAt: number;
	reason?: string;
	supersededBySummaryId?: string;
	error?: string;
}

const logPrefix = "[opencontext/deprecate]";

export function parseDeprecateArgs(argv: string[]): DeprecateOptions {
	const opts: DeprecateOptions = {
		userId: "",
		ids: [],
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
			case "--id":
				opts.ids.push(take());
				break;
			case "--reason":
				opts.reason = take();
				break;
			case "--superseded-by":
				opts.supersededBySummaryId = take();
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				printDeprecateHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`${logPrefix} unknown flag: ${arg}`);
		}
	}

	if (!opts.userId) {
		// Mirror `opencontext add`'s default-to-"default" behaviour so ad-hoc
		// single-tenant scripts keep working. Multi-user hosts should still
		// pass `--user <id>` explicitly to avoid cross-tenant writes.
		opts.userId = "default";
	}
	if (opts.ids.length === 0) {
		throw new Error(`${logPrefix} --id <messageId> is required (repeatable)`);
	}
	return opts;
}

export async function runDeprecate(opts: DeprecateOptions): Promise<number> {
	const manager = await getRawMessageManager();
	if (typeof manager.deprecateMessages !== "function") {
		return emit(
			opts,
			{
				ok: false,
				exit: 1,
				count: 0,
				ids: opts.ids,
				deprecatedAt: Date.now(),
				reason: opts.reason,
				supersededBySummaryId: opts.supersededBySummaryId,
				error: "active raw-message manager exposes no deprecateMessages",
			},
			"error: active raw-message manager exposes no deprecateMessages",
		);
	}

	const deprecatedAt = Date.now();
	const count = await manager.deprecateMessages(opts.ids, {
		userId: opts.userId,
		deprecatedAt,
		reason: opts.reason,
		supersededBySummaryId: opts.supersededBySummaryId,
	});
	const out: DeprecateOutput = {
		ok: true,
		exit: 0,
		count,
		ids: opts.ids,
		deprecatedAt,
		reason: opts.reason,
		supersededBySummaryId: opts.supersededBySummaryId,
	};
	const humanLine =
		count === 0
			? `no-op: ${opts.ids.length} id(s) already deprecated`
			: `deprecated ${count} message${count === 1 ? "" : "s"}: ${opts.ids.join(", ")}`;
	return emit(opts, out, humanLine);
}

function emit(opts: DeprecateOptions, out: DeprecateOutput, humanLine: string): number {
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(out)}\n`);
	} else {
		process.stdout.write(`${humanLine}\n`);
	}
	return out.exit;
}

function printDeprecateHelp(): void {
	console.log(`opencontext deprecate — soft-deprecate raw messages (supersession).

Marks the given message ids as deprecated: the underlying
'raw_messages.deprecated_at' column is set (plus optional
'deprecation_reason' and 'superseded_by_summary_id'). Once deprecated, a
row is hidden from 'opencontext search' by default — opt back in with
'--include-deprecated' for audits of the supersession chain.

This is the write-side complement of the existing
'RawMessageStorageManager.deprecateMessages' JS API. After running this
command, 'search --limit 1' for the same query returns the successor
instead of tying on similarity.

Usage:
  opencontext deprecate [options]

Required:
  --id <messageId>          Message id to deprecate (repeatable)

Identity:
  --user <id>               User / workspace id (default: "default")

Supersession metadata:
  --reason <text>           Free-form deprecation reason (stored in
                            'deprecation_reason')
  --superseded-by <id>      id of the successor message / summary (stored
                            in 'superseded_by_summary_id')

Output:
  --json                    Emit JSON envelope instead of a human line

Examples:
  # Mark an old decision as superseded by a new one
  opencontext deprecate --user alice --id <old-id> \\
    --reason "superseded by tRPC migration" --superseded-by <new-id>

  # Bulk: deprecate every legacy row in a list
  opencontext deprecate --user alice --id <id-1> --id <id-2> --reason "audit cleanup"

  # Script-friendly
  opencontext deprecate --user alice --id <id> --json`);
}
