/**
 * `opencontext okf` — CLI for the OKF v0.2 importer / exporter.
 *
 * Four subcommands:
 *
 *   ingest <dir> [...]    Walk a directory of `.md` files, convert each
 *                         to a `RawMessage`, and persist into the memory
 *                         store under a single userId.
 *   emit                 Query the memory store for a user's facts and
 *                         write them out as a Knowledge Package.
 *   validate <dir>       Check every `.md` file in a directory against
 *                         the OKF v0.2 schema. No writes.
 *   inspect <file>       Parse a single file and print the inferred
 *                         `RawMessage` (no persistence).
 *
 * The console output mirrors `doctor.ts` (human / JSON envelope),
 * while the actual store reads / writes go through the memory-store
 * facade so SQLite and Postgres-backed installers work without
 * changes.
 */

import { readFile, stat } from "node:fs/promises";
import type { RawMessage } from "@melandlabs/indexeddb";
import { createRawMessageStore } from "@melandlabs/memory-store";
import { filterRawMessagesByOkfType, isBlockingOkfIssue, okfToRawMessage } from "./codec.js";
import type { OkfIssue } from "./errors.js";
import { parseOkf, validateOkfFrontMatter } from "./frontmatter.js";
import { type WriteOkfPackageResult, readOkfPackage, writeOkfPackage } from "./package.js";

// ─── Local types ──────────────────────────────────────────────────────

interface RawMessageStorageManagerLike {
	upsertRawMessages?: (input: { userId: string; messages: RawMessage[] }) => Promise<unknown>;
	storeMessages?: (messages: RawMessage[]) => Promise<number[]>;
	queryMessages?: (input: Record<string, unknown>) => Promise<RawMessage[]>;
	queryMessagesGrouped?: (input: Record<string, unknown>) => Promise<Record<string, RawMessage[]>>;
}

// ─── Subcommands ───────────────────────────────────────────────────────

export type OkfAction = "ingest" | "emit" | "validate" | "inspect" | "help";

export interface OkfCommonOptions {
	json?: boolean;
	help?: boolean;
}

export interface OkfIngestOptions extends OkfCommonOptions {
	action: "ingest";
	dir: string;
	user: string;
	bot?: string;
	platform?: string;
	dryRun?: boolean;
	continueOnError?: boolean;
}

export interface OkfEmitOptions extends OkfCommonOptions {
	action: "emit";
	user: string;
	bot?: string;
	platform?: string;
	since?: string;
	until?: string;
	types?: string[];
	includeArchived?: boolean;
	output: string;
	packageName?: string;
}

export interface OkfValidateOptions extends OkfCommonOptions {
	action: "validate";
	dir: string;
}

export interface OkfInspectOptions extends OkfCommonOptions {
	action: "inspect";
	file: string;
}

export interface OkfHelpOptions {
	action: "help";
}

export type OkfOptions =
	| OkfIngestOptions
	| OkfEmitOptions
	| OkfValidateOptions
	| OkfInspectOptions
	| OkfHelpOptions;

/**
 * Parse `argv` (everything after `okf` on the command line) into a
 * discriminated union of sub-action options. Mirrors the manual
 * switch / `takeValue` pattern used by `parseHttpArgs` / `parseMcpArgs`
 * / `parseDoctorArgs` in `opencontext.ts`.
 */
export function parseOkfArgs(argv: string[]): OkfOptions {
	const sub = argv[0];
	const rest = argv.slice(1);

	if (sub === undefined || sub === "--help" || sub === "-h") {
		return { action: "help" };
	}

	if (sub === "ingest") {
		return parseIngest(rest);
	}
	if (sub === "emit") {
		return parseEmit(rest);
	}
	if (sub === "validate") {
		return parseValidate(rest);
	}
	if (sub === "inspect") {
		return parseInspect(rest);
	}
	throw new Error(`[opencontext/okf] unknown sub-command: ${sub}`);
}

/**
 * Split an `--flag=value` argument into `[flag, value]`. Returns
 * `null` when the argument doesn't carry an `=` so the caller can
 * fall back to the original two-token `takeValue()` shape.
 */
function splitFlag(arg: string): [string, string] | null {
	const idx = arg.indexOf("=");
	if (idx <= 0) return null;
	return [arg.slice(0, idx), arg.slice(idx + 1)];
}

const INGEST_FLAGS = new Set([
	"--user",
	"--bot",
	"--platform",
	"--dry-run",
	"--continue-on-error",
	"--json",
	"--help",
	"-h",
]);

function parseIngest(argv: string[]): OkfIngestOptions {
	let dir: string | undefined;
	const opts: OkfIngestOptions = {
		action: "ingest",
		dir: "",
		user: "",
	};
	const logPrefix = "[opencontext/okf]";
	for (let i = 0; i < argv.length; i += 1) {
		const original = argv[i];
		// Accept `--flag=value` in addition to `--flag value`. When the
		// `=` form is used, `inline` carries the value and takeValue just
		// returns it — the for-loop's `i += 1` correctly advances past
		// this argument on its own. The classic two-token shape advances
		// past both the flag and its value.
		const inline = splitFlag(original ?? "");
		const arg = inline ? inline[0] : original;
		const takeValue = () => {
			if (inline !== null) return inline[1];
			i += 1;
			const next = argv[i];
			if (next === undefined) throw new Error(`${logPrefix} ${arg} requires a value`);
			return next;
		};
		switch (arg) {
			case "--user":
				opts.user = takeValue();
				break;
			case "--bot":
				opts.bot = takeValue();
				break;
			case "--platform":
				opts.platform = takeValue();
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--continue-on-error":
				opts.continueOnError = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (dir) {
					throw new Error(`${logPrefix} unexpected positional: ${arg}`);
				}
				dir = arg;
				opts.dir = arg;
				break;
		}
	}
	if (!opts.help && !dir) {
		throw new Error(`${logPrefix} ingest requires a directory argument`);
	}
	if (!opts.help && !opts.user) {
		throw new Error(`${logPrefix} ingest requires --user=<id> (or front-matter user_id)`);
	}
	return opts;
}

const EMIT_FLAGS = new Set([
	"--user",
	"--bot",
	"--platform",
	"--since",
	"--until",
	"--types",
	"--include-archived",
	"--output",
	"--package-name",
	"--json",
	"--help",
	"-h",
]);

function parseEmit(argv: string[]): OkfEmitOptions {
	const opts: OkfEmitOptions = {
		action: "emit",
		user: "",
		output: "",
	};
	const logPrefix = "[opencontext/okf]";
	for (let i = 0; i < argv.length; i += 1) {
		const original = argv[i];
		// Accept `--flag=value` in addition to `--flag value`. When the
		// `=` form is used, `inline` holds the value and the next loop
		// iteration will still see the *next* argument (no double-skip).
		const inline = splitFlag(original ?? "");
		const arg = inline ? inline[0] : original;
		const takeValue = () => {
			if (inline !== null) return inline[1];
			i += 1;
			const next = argv[i];
			if (next === undefined) throw new Error(`${logPrefix} ${arg} requires a value`);
			return next;
		};
		switch (arg) {
			case "--user":
				opts.user = takeValue();
				break;
			case "--bot":
				opts.bot = takeValue();
				break;
			case "--platform":
				opts.platform = takeValue();
				break;
			case "--since":
				opts.since = takeValue();
				break;
			case "--until":
				opts.until = takeValue();
				break;
			case "--types":
				opts.types = takeValue()
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				break;
			case "--include-archived":
				opts.includeArchived = true;
				break;
			case "--output":
				opts.output = takeValue();
				break;
			case "--package-name":
				opts.packageName = takeValue();
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				// `emit` is flag-only — anything that isn't a known flag is a
				// stray positional, which we reject explicitly so the error
				// message doesn't mislead the user into thinking they typo'd a flag.
				throw new Error(`${logPrefix} emit takes no positional arguments (got "${arg}")`);
		}
	}
	if (!opts.help) {
		if (!opts.user) throw new Error(`${logPrefix} emit requires --user=<id>`);
		if (!opts.output) throw new Error(`${logPrefix} emit requires --output=<dir>`);
	}
	return opts;
}

const VALIDATE_FLAGS = new Set(["--json", "--help", "-h"]);

function parseValidate(argv: string[]): OkfValidateOptions {
	let dir: string | undefined;
	const opts: OkfValidateOptions = { action: "validate", dir: "" };
	const logPrefix = "[opencontext/okf]";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") {
			opts.json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			opts.help = true;
			continue;
		}
		if (!VALIDATE_FLAGS.has(arg)) {
			if (dir) throw new Error(`${logPrefix} unexpected positional: ${arg}`);
			dir = arg;
			opts.dir = arg;
			continue;
		}
		throw new Error(`${logPrefix} unknown flag: ${arg}`);
	}
	if (!opts.help && !dir) {
		throw new Error(`${logPrefix} validate requires a directory argument`);
	}
	return opts;
}

const INSPECT_FLAGS = new Set(["--json", "--help", "-h"]);

function parseInspect(argv: string[]): OkfInspectOptions {
	let file: string | undefined;
	const opts: OkfInspectOptions = { action: "inspect", file: "" };
	const logPrefix = "[opencontext/okf]";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") {
			opts.json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			opts.help = true;
			continue;
		}
		if (!INSPECT_FLAGS.has(arg)) {
			if (file) throw new Error(`${logPrefix} unexpected positional: ${arg}`);
			file = arg;
			opts.file = arg;
			continue;
		}
		throw new Error(`${logPrefix} unknown flag: ${arg}`);
	}
	if (!opts.help && !file) {
		throw new Error(`${logPrefix} inspect requires a file argument`);
	}
	return opts;
}

// ─── Help ──────────────────────────────────────────────────────────────

export function printOkfHelp(): void {
	console.log(`opencontext okf — OKF v0.2 (Open Knowledge Format) importer / exporter.

Usage:
  opencontext okf <command> [options]

Commands:
  ingest <dir>    Convert a directory of .md files into RawMessage records and persist to the memory store.
  emit            Export a user's facts as a Knowledge Package (directory of .md + manifest.json).
  validate <dir>  Check every .md file in a directory against the OKF v0.2 schema. No writes.
  inspect <file>  Parse a single file and print the inferred RawMessage. No writes.

Run "opencontext okf <command> --help" for command-specific options.

Examples:
  opencontext okf ingest ./my-wiki --user=alice --json
  opencontext okf validate ./my-wiki --json
  opencontext okf inspect ./my-wiki/Reference/foo.md --json
  opencontext okf emit --user=alice --output=./export-2026-08-19 --json`);
}

function printIngestHelp(): void {
	console.log(`opencontext okf ingest <dir> [options]

  --user=<id>             Fallback userId when a doc lacks front-matter user_id (required).
  --bot=<id>              Fallback botId. Default: "okf-import".
  --platform=<p>          Fallback platform. Default: "okf".
  --dry-run               Parse + validate, do not ingest.
  --continue-on-error     Collect issues per file instead of failing on the first bad doc.
  --json                  Emit stable JSON envelope (ok / exit / summary / issues[]).
  --help, -h

Exit codes:
  0  all files ingested (or validated in --dry-run)
  1  at least one file failed to ingest or produced a blocking issue`);
}

function printEmitHelp(): void {
	console.log(`opencontext okf emit [options]

  --user=<id>             User to export (required).
  --bot=<id>              Filter: only this botId.
  --platform=<p>          Filter: only this platform.
  --since=<iso|ms>        Filter: timestamp >= since.
  --until=<iso|ms>        Filter: timestamp <= until.
  --types=<t1,t2,...>     Filter: only these OKF types (Reference, Opinion, ...).
  --include-archived      Include deprecated / archived facts.
  --output=<dir>          Required; writes manifest.json + <Type>/<slug>.md tree.
  --package-name=<name>   Manifest name override.
  --json                  Emit stable JSON envelope (ok / exit / written / path).
  --help, -h`);
}

function printValidateHelp(): void {
	console.log(`opencontext okf validate <dir> [options]

  --json                  Emit stable JSON envelope ({ ok, exit, results }).
  --help, -h`);
}

function printInspectHelp(): void {
	console.log(`opencontext okf inspect <file> [options]

  --json                  Emit stable JSON envelope ({ frontMatter, body, inferredRawMessage }).
  --help, -h`);
}

// ─── Entry point ───────────────────────────────────────────────────────

export interface OkfRunResult {
	ok: boolean;
	exit: number;
}

export interface OkfRunOptions {
	/** Package version used as the `generated.by` fallback. */
	packageVersion?: string;
	/**
	 * Optional sink for the JSON envelope when `json: true`. When set,
	 * `startOkf` writes the envelope here instead of `console.log`,
	 * which lets tests / demos inspect the summary without monkey-patching
	 * the global console.
	 */
	sink?: (line: string) => void;
}

/**
 * Emit the JSON envelope to either the user-supplied `sink` (when set)
 * or `console.log`. Centralised here so every `if (args.json) ...` site
 * uses the same code path.
 */
function emitJson(sink: ((line: string) => void) | undefined, payload: unknown): void {
	const text = JSON.stringify(payload, null, 2);
	if (sink) sink(text);
	else console.log(text);
}

/**
 * Run the OKF action with the given options. Returns the exit code.
 */
export async function startOkf(args: OkfOptions, runOptions: OkfRunOptions = {}): Promise<OkfRunResult> {
	if (args.action === "help") {
		printOkfHelp();
		return { ok: true, exit: 0 };
	}
	if (args.action === "ingest") {
		if (args.help) {
			printIngestHelp();
			return { ok: true, exit: 0 };
		}
		return runIngest(args, runOptions);
	}
	if (args.action === "emit") {
		if (args.help) {
			printEmitHelp();
			return { ok: true, exit: 0 };
		}
		return runEmit(args, runOptions);
	}
	if (args.action === "validate") {
		if (args.help) {
			printValidateHelp();
			return { ok: true, exit: 0 };
		}
		return runValidate(args, runOptions);
	}
	if (args.action === "inspect") {
		if (args.help) {
			printInspectHelp();
			return { ok: true, exit: 0 };
		}
		return runInspect(args, runOptions);
	}
	// Exhaustiveness check.
	throw new Error(`[opencontext/okf] unhandled action: ${JSON.stringify(args)}`);
}

// ─── ingest ────────────────────────────────────────────────────────────

export interface OkfIngestSummary {
	ok: boolean;
	exit: number;
	summary: {
		ingested: number;
		skipped: number;
		issues: number;
	};
	issues: Array<{ file: string; issues: OkfIssue[] }>;
}

async function runIngest(args: OkfIngestOptions, runOptions: OkfRunOptions): Promise<OkfRunResult> {
	const { sink } = runOptions;
	const log = (msg: string) => console.warn(`[opencontext/okf] ${msg}`);
	const pkg = await readOkfPackage(args.dir);
	if (pkg.files.length === 0) {
		log(`no .md files found in ${args.dir}`);
	}

	const existingIds = await collectExistingIds(args.user, args.bot);
	const messages: RawMessage[] = [];
	const allIssues: Array<{ file: string; issues: OkfIssue[] }> = [];
	// Batch-local set of messageIds so we can warn when two files in the
	// same package resolve to the same `resource` (an explicit resource
	// skips the dedup suffix, so the later file would silently overwrite
	// the earlier one on upsert). Not seeded from the store — colliding
	// with an *already-persisted* id is the intended in-place upsert.
	const seenSlugs = new Set<string>();
	let skipped = 0;
	for (const file of pkg.files) {
		// File-level parse errors are already in the file.issues list.
		// Skip files that have a parse error so we don't push garbage.
		if (file.issues.some((i) => i.code === "invalid_yaml")) {
			skipped += 1;
			allIssues.push({ file: file.path, issues: file.issues });
			continue;
		}
		const codec = okfToRawMessage(
			{ frontMatter: file.document.frontMatter, body: file.document.body },
			{
				userId: args.user,
				botId: args.bot,
				platform: args.platform,
				existingIds,
				file: file.path,
				mtimeMs: file.mtimeMs,
			},
		);
		// Mirror HTTP/MCP: blocking validation issues (the shared
		// `OKF_BLOCKING_ISSUE_CODES` set) mean the doc can't be a valid
		// fact. Skip the upsert and surface the issue instead of polluting
		// the store with a half-built RawMessage.
		const hasBlocking = codec.issues.some(isBlockingOkfIssue);
		if (hasBlocking) {
			skipped += 1;
			allIssues.push({ file: file.path, issues: codec.issues });
			continue;
		}
		messages.push(codec.rawMessage);
		existingIds.add(codec.messageId);
		if (seenSlugs.has(codec.messageId)) {
			codec.issues.push({
				code: "duplicate_resource",
				message: `resource "${codec.messageId}" resolves to the same id as another file in this package; the earlier file will be overwritten on upsert`,
				file: file.path,
			});
		}
		seenSlugs.add(codec.messageId);
		if (codec.issues.length > 0) {
			allIssues.push({ file: file.path, issues: codec.issues });
		}
	}

	if (args.dryRun) {
		const hasBlockingIssue = allIssues.some((entry) => entry.issues.some(isBlockingOkfIssue));
		const exit = hasBlockingIssue ? 1 : 0;
		const summary: OkfIngestSummary = {
			ok: exit === 0,
			exit,
			summary: { ingested: 0, skipped, issues: allIssues.length },
			issues: allIssues,
		};
		if (args.json) {
			emitJson(sink, summary);
		} else {
			renderIngestHuman(summary, pkg.files.length);
		}
		return { ok: summary.ok, exit: summary.exit };
	}

	if (messages.length > 0) {
		const store = createRawMessageStore({});
		try {
			const manager = (await store.getManager()) as RawMessageStorageManagerLike;
			if (typeof manager.upsertRawMessages === "function") {
				await manager.upsertRawMessages({ userId: args.user, messages });
			} else if (typeof manager.storeMessages === "function") {
				await manager.storeMessages(messages);
			} else {
				throw new Error("active raw-message manager exposes neither upsertRawMessages nor storeMessages");
			}
		} finally {
			// Always release the store handle, even on the throw above, so
			// we don't leak a connection on subsequent runs.
			await store.close().catch(() => undefined);
		}
	}

	const hasBlockingIssue = allIssues.some((entry) => entry.issues.some(isBlockingOkfIssue));
	// Blocking issues (the shared `OKF_BLOCKING_ISSUE_CODES` set) are
	// structural failures (the doc literally cannot be a fact), so they
	// always force a non-zero exit regardless of `--continue-on-error`.
	// Other issues remain soft with `--continue-on-error`.
	const exit = hasBlockingIssue ? 1 : 0;
	const summary: OkfIngestSummary = {
		ok: exit === 0,
		exit,
		summary: { ingested: messages.length, skipped, issues: allIssues.length },
		issues: allIssues,
	};

	if (args.json) {
		emitJson(sink, summary);
	} else {
		renderIngestHuman(summary, pkg.files.length);
	}
	return { ok: summary.ok, exit: summary.exit };
}

function renderIngestHuman(summary: OkfIngestSummary, total: number): void {
	const lines: string[] = ["[opencontext/okf] ingest"];
	lines.push(`  ✓ scanned ${total} file(s)`);
	lines.push(`  ✓ ingested ${summary.summary.ingested} fact(s)`);
	if (summary.summary.skipped > 0) {
		lines.push(`  ⚠ skipped ${summary.summary.skipped}`);
	}
	if (summary.summary.issues > 0) {
		lines.push(`  ⚠ ${summary.summary.issues} file(s) had issues:`);
		for (const entry of summary.issues) {
			for (const issue of entry.issues) {
				lines.push(`    - ${entry.file}: ${issue.code} — ${issue.message}`);
			}
		}
	}
	lines.push("");
	lines.push(
		`Summary: ${summary.summary.ingested} ingested, ${summary.summary.skipped} skipped, ${summary.summary.issues} issue(s)`,
	);
	console.log(lines.join("\n"));
}

async function collectExistingIds(userId: string, botId?: string): Promise<Set<string>> {
	const store = createRawMessageStore({});
	try {
		const manager = await store.getManager();
		if (typeof manager.queryMessages !== "function") return new Set();
		const rows = (await manager.queryMessages({
			userId,
			// Match the export / import-batch query ceiling so the dedup
			// set is complete for large stores.
			limit: 100_000,
			includeArchived: true,
			...(botId ? { botId } : {}),
		})) as Array<{ messageId: string }>;
		return new Set(rows.map((r) => r.messageId));
	} catch {
		return new Set();
	} finally {
		await store.close().catch(() => undefined);
	}
}

// ─── emit ──────────────────────────────────────────────────────────────

export interface OkfEmitSummary {
	ok: boolean;
	exit: number;
	written: number;
	path: string;
	manifest?: import("@melandlabs/contracts").OkfPackageManifest;
}

async function runEmit(args: OkfEmitOptions, runOptions: OkfRunOptions): Promise<OkfRunResult> {
	const { sink } = runOptions;
	const log = (msg: string) => console.warn(`[opencontext/okf] ${msg}`);
	const store = createRawMessageStore({});
	let result: WriteOkfPackageResult;
	try {
		const manager = await store.getManager();
		const query: Record<string, unknown> = {
			userId: args.user,
			limit: 100_000,
			...(args.bot ? { botId: args.bot } : {}),
			...(args.platform ? { platform: args.platform } : {}),
			...(args.includeArchived ? { includeArchived: true } : {}),
		};
		if (args.since !== undefined) {
			query.startTime = parseTime(args.since, "since");
		}
		if (args.until !== undefined) {
			query.endTime = parseTime(args.until, "until");
		}
		let rows: RawMessage[] = [];
		if (typeof manager.queryMessages === "function") {
			rows = (await manager.queryMessages(query)) as RawMessage[];
		} else if (typeof manager.queryMessagesGrouped === "function") {
			// Fallback: read everything by group and concat.
			const grouped = (await manager.queryMessagesGrouped(query)) as Record<string, RawMessage[]>;
			rows = Object.values(grouped).flat();
		} else {
			throw new Error("active raw-message manager exposes neither queryMessages nor queryMessagesGrouped");
		}

		// Filter by OKF type at the codec level (the manager doesn't
		// understand OKF types so we apply the filter in JS after the
		// query returns). The shared helper also handles records whose
		// `metadata.okfType` was never written (inferring from factType),
		// keeping CLI / HTTP / MCP behaviour identical.
		const filtered = filterRawMessagesByOkfType(rows, args.types);

		result = await writeOkfPackage(args.output, filtered, {
			userIds: [args.user],
			platforms: args.platform ? [args.platform] : [],
			packageName: args.packageName,
			packageVersion: runOptions.packageVersion,
			includeArchived: args.includeArchived,
		});
	} finally {
		await store.close().catch(() => undefined);
	}

	const summary: OkfEmitSummary = {
		ok: true,
		exit: 0,
		written: result.written,
		path: args.output,
		manifest: result.manifest,
	};

	if (args.json) {
		emitJson(sink, summary);
	} else {
		log(`wrote ${result.written} fact(s) to ${args.output}`);
		log(`manifest: ${result.manifest.name} (conceptCount=${result.manifest.okfConceptCount})`);
	}
	return { ok: true, exit: 0 };
}

function parseTime(value: string, flag: string): number {
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	const ms = Date.parse(trimmed);
	if (Number.isNaN(ms)) {
		throw new Error(`[opencontext/okf] invalid ${flag}: ${value} (expected ISO 8601 or epoch ms)`);
	}
	return ms;
}

// ─── validate ──────────────────────────────────────────────────────────

export interface OkfValidateSummary {
	ok: boolean;
	exit: number;
	results: Array<{ file: string; valid: boolean; issues: OkfIssue[] }>;
}

async function runValidate(args: OkfValidateOptions, runOptions: OkfRunOptions): Promise<OkfRunResult> {
	const { sink } = runOptions;
	const pkg = await readOkfPackage(args.dir);
	const results: OkfValidateSummary["results"] = pkg.files.map((f) => ({
		file: f.path,
		// A file is "valid" only when it has no *blocking* issue. Soft
		// warnings (e.g. missing_generated_by) are surfaced in `issues`
		// but don't fail validate — keeping it consistent with ingest,
		// HTTP and MCP, which all defer to the shared blocking set.
		valid: !f.issues.some(isBlockingOkfIssue),
		issues: f.issues,
	}));
	const exit = results.some((r) => !r.valid) ? 1 : 0;
	const summary: OkfValidateSummary = { ok: exit === 0, exit, results };
	if (args.json) {
		emitJson(sink, summary);
	} else {
		renderValidateHuman(summary);
	}
	return { ok: summary.ok, exit: summary.exit };
}

function renderValidateHuman(summary: OkfValidateSummary): void {
	const lines: string[] = ["[opencontext/okf] validate"];
	for (const r of summary.results) {
		if (r.valid) {
			lines.push(`  ✓ ${r.file}`);
		} else {
			lines.push(`  ✗ ${r.file}`);
			for (const issue of r.issues) {
				lines.push(`    - ${issue.code}: ${issue.message}`);
			}
		}
	}
	lines.push("");
	const failures = summary.results.filter((r) => !r.valid).length;
	lines.push(`Summary: ${passedResultCount(summary.results)} passed, ${failures} failed`);
	console.log(lines.join("\n"));
}

function passedResultCount(results: OkfValidateSummary["results"]): number {
	return results.filter((r) => r.valid).length;
}

// ─── inspect ───────────────────────────────────────────────────────────

export interface OkfInspectSummary {
	frontMatter: import("@melandlabs/contracts").OkfFrontMatter;
	body: string;
	inferredRawMessage?: RawMessage;
	issues: OkfIssue[];
}

export interface OkfInspectOutput {
	ok: boolean;
	exit: number;
	result: OkfInspectSummary;
}

async function runInspect(args: OkfInspectOptions, runOptions: OkfRunOptions): Promise<OkfRunResult> {
	const { sink } = runOptions;
	let text: string;
	try {
		const s = await stat(args.file);
		if (!s.isFile()) {
			throw new Error(`not a file: ${args.file}`);
		}
		text = await readFile(args.file, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const output = {
			ok: false,
			exit: 1,
			error: message,
		};
		if (args.json) {
			emitJson(sink, output);
		} else {
			console.error(`[opencontext/okf] ${message}`);
		}
		return { ok: false, exit: 1 };
	}
	const parsed = parseOkf(text);
	const issues = validateOkfFrontMatter(parsed.frontMatter);
	// Inspect never persists — the codec requires a userId, so we
	// build the preview by running the codec with the front-matter's
	// own `user_id` (if present) or a clearly-marked placeholder.
	// The placeholder userId uses a reserved namespace (`__inspect__`)
	// so anyone who accidentally forwards the preview into an upsert
	// can be alerted by the namespace collision.
	let inferred: RawMessage | undefined;
	let exit = 0;
	const previewUserId = parsed.frontMatter.user_id ?? INSPECT_PLACEHOLDER_USER;
	try {
		const codec = okfToRawMessage(parsed, {
			userId: previewUserId,
			botId: parsed.frontMatter.bot_id ?? "okf-inspect",
			platform: parsed.frontMatter.platform ?? "okf",
		});
		inferred = codec.rawMessage;
		issues.push(...codec.issues);
		if (previewUserId === INSPECT_PLACEHOLDER_USER) {
			issues.push({
				code: "missing_resource",
				message:
					"no front-matter `user_id` — the preview was synthesised with a placeholder userId and must not be persisted",
			});
			// Suppress the preview entirely when we had to invent the userId;
			// downstream tools must not see a RawMessage they could mistake
			// for real input.
			inferred = undefined;
		}
	} catch (err) {
		exit = 1;
		inferred = {
			messageId: "inspect-failed",
			userId: previewUserId,
			botId: "okf-inspect",
			platform: "okf",
			timestamp: Date.now(),
			content: parsed.body,
			metadata: { okfFrontMatter: parsed.frontMatter },
			createdAt: Date.now(),
		};
		issues.push({
			code: "invalid_frontmatter",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	const summary: OkfInspectSummary = {
		frontMatter: parsed.frontMatter,
		body: parsed.body,
		inferredRawMessage: inferred,
		issues,
	};
	const output: OkfInspectOutput = { ok: exit === 0, exit, result: summary };
	if (args.json) {
		emitJson(sink, output);
	} else {
		renderInspectHuman(summary);
	}
	return { ok: output.ok, exit: output.exit };
}

const INSPECT_PLACEHOLDER_USER = "__inspect__";

function renderInspectHuman(summary: OkfInspectSummary): void {
	const lines: string[] = ["[opencontext/okf] inspect"];
	lines.push("front-matter:");
	for (const [key, value] of Object.entries(summary.frontMatter)) {
		lines.push(`  ${key}: ${JSON.stringify(value)}`);
	}
	lines.push("");
	lines.push("body (first 80 lines):");
	const bodyLines = summary.body.split(/\r?\n/);
	for (const line of bodyLines.slice(0, 80)) {
		lines.push(`  ${line}`);
	}
	if (bodyLines.length > 80) {
		lines.push(`  ... (${bodyLines.length - 80} more line(s))`);
	}
	lines.push("");
	lines.push("inferred RawMessage:");
	if (summary.inferredRawMessage) {
		lines.push(`  messageId: ${summary.inferredRawMessage.messageId}`);
		lines.push(`  factType: ${summary.inferredRawMessage.factType}`);
		lines.push(`  timestamp: ${summary.inferredRawMessage.timestamp}`);
	} else {
		lines.push("  (no RawMessage preview — front-matter `user_id` is required to build one)");
	}
	if (summary.issues.length > 0) {
		lines.push("");
		lines.push("issues:");
		for (const issue of summary.issues) {
			lines.push(`  - ${issue.code}: ${issue.message}`);
		}
	}
	console.log(lines.join("\n"));
}

// ─── helpers ──────────────────────────────────────────────────────────

// Re-export the codec helpers so callers can `import { ... } from "@melandlabs/okf/cli"`.
export { okfToRawMessage, rawMessageToOkf } from "./codec.js";
export { parseOkf, parseOkfFrontMatter, stringifyOkf, validateOkfFrontMatter } from "./frontmatter.js";
export { readOkfPackage, writeOkfPackage } from "./package.js";
