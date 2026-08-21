/**
 * `opencontext search` — unified read across the active manager, modelled
 * after memvid's `find`. Single verb, three `--mode` flavours, one
 * `--context-only` escape hatch that surfaces the exact prompt context
 * that would have been sent to the LLM (no synthesis call).
 *
 * `--mode` mapping (best-effort approximation — the underlying unified
 * search always runs semantic + lexical, RRF just changes how the two
 * signals are merged):
 *   auto (default) — `mergeStrategy: "rrf"`, all three sources
 *   lex           — `mergeStrategy: "similarity"`, default sources
 *   sem           — `mergeStrategy: "similarity"`, `sources: ["memory"]`
 *
 * `--context-only` runs the read pipeline with `synthesize: false` and
 * prints the evidence that *would* have been fed to the LLM. No
 * `OPENROUTER_API_KEY` needed; nothing is sent to any model.
 *
 * Exit codes:
 *   0 — search completed (zero results is still success)
 *   1 — validation error, backend refused, or threw mid-search
 *
 * Output:
 *   default        human-readable per-hit lines
 *   --context-only prompt-context dump (what `--synthesize` would send)
 *   --json         full `SearchOutput` envelope
 *   --explain      also include reasoning + warnings in human output
 */

import { createMemoryStore } from "@melandlabs/memory-store";
import type { SearchInput, SearchOutput } from "@melandlabs/memory-store";

export type SearchMode = "auto" | "lex" | "sem";

export interface SearchOptions {
	userId: string;
	query: string;
	mode: SearchMode;
	k: number;
	threshold?: number;
	botIds: string[];
	kinds: string[];
	since?: string;
	until?: string;
	contextOnly: boolean;
	json: boolean;
	explain: boolean;
}

export interface SearchEnvelope {
	ok: boolean;
	exit: number;
	query: string;
	count: number;
	results: SearchOutput["results"];
	evidence?: SearchOutput["evidence"];
	reasoning?: SearchOutput["reasoning"];
	warnings?: SearchOutput["warnings"];
	error?: string;
}

const logPrefix = "[opencontext/search]";
const ALLOWED_MODES: ReadonlyArray<SearchMode> = ["auto", "lex", "sem"];

export function parseSearchArgs(argv: string[]): SearchOptions {
	const opts: SearchOptions = {
		userId: "",
		query: "",
		mode: "auto",
		k: 10,
		botIds: [],
		kinds: [],
		contextOnly: false,
		json: false,
		explain: false,
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
			case "--query":
			case "-q":
				opts.query = take();
				break;
			case "--mode":
				opts.mode = take() as SearchMode;
				break;
			case "--k":
			case "--limit":
				opts.k = Number.parseInt(take(), 10);
				break;
			case "--threshold":
				opts.threshold = Number.parseFloat(take());
				break;
			case "--bot":
				opts.botIds.push(take());
				break;
			case "--kind":
				opts.kinds.push(take());
				break;
			case "--since":
				opts.since = take();
				break;
			case "--until":
				opts.until = take();
				break;
			case "--context-only":
				opts.contextOnly = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--explain":
				opts.explain = true;
				break;
			case "--help":
			case "-h":
				printSearchHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`${logPrefix} unknown flag: ${arg}`);
		}
	}

	if (!opts.userId) {
		// Default to a single shared tenant when the flag is omitted —
		// matches the add command's behavior. Multi-user hosts should
		// still pass `--user <id>` explicitly to avoid cross-tenant reads.
		opts.userId = "default";
	}
	if (!opts.query) {
		throw new Error(`${logPrefix} --query <text> is required`);
	}
	if (!ALLOWED_MODES.includes(opts.mode)) {
		throw new Error(`${logPrefix} --mode must be one of: ${ALLOWED_MODES.join(", ")} (got "${opts.mode}")`);
	}
	if (!Number.isFinite(opts.k) || opts.k <= 0) {
		throw new Error(`${logPrefix} --k must be a positive integer (got "${opts.k}")`);
	}
	if (
		opts.threshold !== undefined &&
		(!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 1)
	) {
		throw new Error(`${logPrefix} --threshold must be in [0, 1] (got "${opts.threshold}")`);
	}
	for (const date of [opts.since, opts.until]) {
		if (date && Number.isNaN(Date.parse(date))) {
			throw new Error(`${logPrefix} --since/--until expect ISO-8601 (got "${date}")`);
		}
	}
	return opts;
}

export async function runSearch(opts: SearchOptions): Promise<number> {
	const store = await createMemoryStore();

	const input: SearchInput = {
		userId: opts.userId,
		query: opts.query,
		limit: opts.k,
		threshold: opts.threshold,
		botIds: opts.botIds.length > 0 ? opts.botIds : undefined,
		factTypes: opts.kinds.length > 0 ? (opts.kinds as SearchInput["factTypes"]) : undefined,
		dateFrom: opts.since,
		dateTo: opts.until,
		mergeStrategy: opts.mode === "auto" ? "rrf" : "similarity",
		sources: opts.mode === "sem" ? (["memory"] as const) : undefined,
		// Critical: --context-only must never spend an LLM call.
		synthesize: false,
	};

	let out: SearchOutput;
	try {
		out = await store.search(input);
	} catch (error) {
		const err = error as Error;
		const env: SearchEnvelope = {
			ok: false,
			exit: 1,
			query: opts.query,
			count: 0,
			results: [],
			error: err.message,
		};
		process.stdout.write(`${opts.json ? JSON.stringify(env) : `error: ${err.message}`}\n`);
		return env.exit;
	}

	const envelope: SearchEnvelope = {
		ok: true,
		exit: 0,
		query: out.query,
		count: out.count,
		results: out.results,
		evidence: out.evidence,
		reasoning: out.reasoning,
		warnings: out.warnings,
	};

	if (opts.contextOnly) {
		return emitContextOnly(opts, envelope);
	}
	if (opts.json) {
		return emitJson(opts, envelope);
	}
	return emitHuman(opts, envelope, out);
}

function emitJson(_opts: SearchOptions, env: SearchEnvelope): number {
	process.stdout.write(`${JSON.stringify(env)}\n`);
	return env.exit;
}

function emitContextOnly(opts: SearchOptions, env: SearchEnvelope): number {
	const lines: string[] = [];
	lines.push("# context-only — what would be sent to the LLM");
	lines.push(`# user=${opts.userId} query=${JSON.stringify(env.query)}`);
	lines.push(`# count=${env.count} (no synthesis call made)`);
	lines.push("");
	for (const ev of env.evidence ?? []) {
		const ts = ev.timestamp ? new Date(ev.timestamp).toISOString() : "—";
		lines.push(`[${ev.score.toFixed(3)}] ${ev.source} @ ${ts}`);
		lines.push(`    id: ${ev.id}`);
		lines.push(`    ${ev.snippet}`);
		lines.push("");
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return env.exit;
}

function emitHuman(opts: SearchOptions, env: SearchEnvelope, out: SearchOutput): number {
	const lines: string[] = [];
	if (out.results.length === 0) {
		lines.push(`(no results for query ${JSON.stringify(env.query)})`);
	} else {
		for (const r of out.results) {
			const preview = r.content.replace(/\s+/g, " ").slice(0, 160);
			lines.push(
				`[${r.similarity.toFixed(3)}] ${r.type}:${r.id} — ${preview}${preview.length === 160 ? "…" : ""}`,
			);
		}
	}
	if (opts.explain) {
		if (out.reasoning) {
			lines.push("");
			const degraded = out.reasoning.degraded ? " (degraded)" : "";
			const iterations =
				out.reasoning.iterations !== undefined ? ` iterations=${out.reasoning.iterations}` : "";
			lines.push(`# reasoning: strategy=${out.reasoning.strategy}${degraded}${iterations}`);
		}
		if (out.warnings && out.warnings.length > 0) {
			lines.push("# warnings:");
			for (const w of out.warnings) {
				lines.push(`  - [${w.code}] ${w.source}: ${w.message}`);
			}
		}
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return env.exit;
}

function printSearchHelp(): void {
	console.log(`opencontext search — unified read across the active manager.

Usage:
  opencontext search [options]

Required:
  --query <text>             Search query (also -q)

Identity:
  --user <id>                User / workspace id (default: "default")

Mode:
  --mode <name>              auto (default) | lex | sem
                              auto → RRF hybrid across all three sources
                              lex  → similarity-sorted, default sources
                              sem  → similarity-sorted, memory source only

Filtering:
  --k <int>                  Top-k results (default: 10, also --limit)
  --threshold <float>        Similarity threshold in [0, 1]
  --bot <id>                 Filter to one bot (repeatable)
  --kind <factType>          Filter to one fact type (repeatable)
  --since <iso-8601>         Inclusive start date for memory timestamps
  --until <iso-8601>         Inclusive end date for memory timestamps

Output:
  --json                     Emit full SearchOutput as JSON
  --context-only             Print the prompt context that would have been
                             sent to the LLM (no synthesis call)
  --explain                  In human output, also show reasoning + warnings

Examples:
  # Plain hybrid search
  opencontext search --user alice --query "memory safety"

  # Lex-only, top 5
  opencontext search --user alice --query "memory safety" --mode lex --k 5

  # Date-scoped
  opencontext search --user alice --query "Q4 roadmap" \\
    --since 2026-08-01 --until 2026-08-31 --k 20

  # Debug: see what the LLM would have received, without paying for it
  opencontext search --user alice --query "上周末聊了什么" --context-only

  # Script-friendly
  opencontext search --user alice --query "x" --json | jq '.results[].id'`);
}
