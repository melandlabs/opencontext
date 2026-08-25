/**
 * `opencontext doctor` — read-only health checks across the facade's
 * subsystems.
 *
 * A single command
 * the user can run when something feels wrong ("why won't this start?",
 * "is my Postgres factory registered?", "where's my audit log?", …)
 * without having to read source code.
 *
 * v1 deliberately does NOT mutate state. There is no `--fix` knob — the
 * PowerContext implementation is also read-only, and auto-fix here would
 * risk silently changing a user's install. Every check is best-effort:
 * a thrown library import never crashes the doctor.
 *
 * Shape:
 *   - 9 sections (runtime, filesystem, loop, memory-store, embedding,
 *     policies, audit, security, integrations), each producing an array
 *     of `CheckResult`s.
 *   - `--section <name>` narrows to one section; an unknown name emits
 *     a single `warn` result, not a hard fail, so a typo never makes
 *     CI look broken.
 *   - `--json` emits a machine-readable envelope; `--verbose` includes
 *     passing checks (default: warns + fails only).
 *   - `--deep` opts into a real memory-store read probe (off by default
 *     to keep `doctor` cheap in CI).
 *   - `--user <id>` overrides the default `__doctor__` probe id for
 *     policy checks — useful when a user wants to sanity-check their
 *     own cohort membership without having to write a script.
 *
 * Exit codes:
 *   0 — no `fail` results
 *   1 — at least one `fail` result
 *
 * The bundler (`tsup`) already wires `cli/opencontext.ts` as a bin
 * entry and `noExternal: [/^@melandlabs\/(?!ai-rag(?:\/|$))/]`
 * inlines every workspace dep — `@melandlabs/ai-rag` is external on
 * purpose (it's an optional peer the consumer installs separately),
 * but the symbols we use here (`getEmbeddingProviderType`,
 * `getConfiguredEmbeddingModelName`) are pure env-var probes and
 * never load the ONNX runtime.
 */

import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	getConfiguredEmbeddingModelName,
	getEmbeddingProviderType,
} from "@melandlabs/ai-rag/embedding-provider";
import { AUDIT_LOG_PATH, readAuditLogs } from "@melandlabs/audit";
import { INTEGRATION_IDS, isIntegrationId } from "@melandlabs/contracts";
import { APP_DIR_NAME } from "@melandlabs/env-config";
import { listLoopCliCandidates, readPreferences, resolveLoopCli } from "@melandlabs/loop";
import {
	closeRawMessageStore,
	getRawMessageStorageBackend,
	hasPostgresFactory,
	isRawMessageStorageAvailable,
} from "@melandlabs/memory-store";
import { resolveMemoryGraphCorrectionPolicy } from "@melandlabs/memory-store/memory-graph-correction-policy";
import { resolveMemoryGraphWritePolicy } from "@melandlabs/memory-store/memory-graph-write-policy";
import { resolveSQLiteRawMessageDbPath } from "@melandlabs/memory-store/sqlite-raw-message-store";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckResult {
	section: string;
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

export interface DoctorOptions {
	/** Filter to one section (e.g. "memory-store"). Warn on unknown name. */
	section?: string;
	/** Emit `{ok, exit, results}` JSON instead of human-readable output. */
	json?: boolean;
	/** Include passing checks (default: warns + fails only). */
	verbose?: boolean;
	/** Override the default `__doctor__` probe id for policy checks. */
	userId?: string;
	/** Override `os.homedir()` for filesystem checks (testing hook). */
	homeDir?: string;
	/** Opt-in: run a real memory-store read probe. Default false. */
	deep?: boolean;
}

export interface DoctorOutput {
	ok: boolean;
	exit: number;
	results: CheckResult[];
}

export interface DoctorContext {
	homeDir: string;
	userId: string;
	deep: boolean;
}

// ─── Section entry points ──────────────────────────────────────────────────

const SECTION_NAMES = [
	"runtime",
	"filesystem",
	"loop",
	"memory-store",
	"embedding",
	"policies",
	"audit",
	"security",
	"integrations",
	"distill",
	"entity-search",
	"derive",
] as const;

type SectionName = (typeof SECTION_NAMES)[number];

type SectionRunner = (ctx: DoctorContext) => Promise<CheckResult[]>;

const SECTIONS: Record<SectionName, SectionRunner> = {
	runtime: checkRuntime,
	filesystem: checkFilesystem,
	loop: checkLoop,
	"memory-store": checkMemoryStore,
	embedding: checkEmbedding,
	policies: checkPolicies,
	audit: checkAudit,
	security: checkSecurity,
	integrations: checkIntegrations,
	distill: checkDistill,
	"entity-search": checkEntitySearch,
	derive: checkDerive,
};

// ─── Argument parser ───────────────────────────────────────────────────────

const VALID_FLAGS = new Set(["--section", "--json", "--verbose", "--user", "--deep", "--help", "-h"]);

/**
 * Parse `argv` (everything after the `doctor` token on the command line)
 * into a `DoctorOptions`. Unknown flags throw — matches the
 * `parseHttpArgs` / `parseMcpArgs` shape so a stray flag is noisy
 * rather than silently ignored.
 */
export function parseDoctorArgs(argv: string[]): DoctorOptions {
	const opts: DoctorOptions = {};
	const logPrefix = "[opencontext/doctor]";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		const takeValue = () => {
			if (next === undefined) throw new Error(`${logPrefix} ${arg} requires a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--section":
				opts.section = takeValue();
				break;
			case "--json":
				opts.json = true;
				break;
			case "--verbose":
				opts.verbose = true;
				break;
			case "--user":
				opts.userId = takeValue();
				break;
			case "--deep":
				opts.deep = true;
				break;
			case "--help":
			case "-h":
				printDoctorHelp();
				process.exit(0);
				break;
			default:
				if (arg && !VALID_FLAGS.has(arg)) {
					throw new Error(`${logPrefix} unknown flag: ${arg}`);
				}
				// Defensive — should be unreachable because of the set
				// membership check.
				throw new Error(`${logPrefix} unknown flag: ${arg}`);
		}
	}
	return opts;
}

// ─── Help text ─────────────────────────────────────────────────────────────

export function printDoctorHelp(): void {
	console.log(`opencontext doctor — read-only health checks for the local install.

Usage:
  opencontext doctor [options]

Options:
  --section <name>     Run only one section (runtime, filesystem, loop,
                       memory-store, embedding, policies, audit, security,
                       integrations, distill, entity-search, derive).
                       Unknown sections warn, do not fail.
  --json               Emit a machine-readable { ok, exit, results } envelope
                       (stable shape — safe for CI gates).
  --verbose            Show passing checks too (default: warn + fail only).
  --user <id>          Probe policies for this userId instead of the
                       synthetic "__doctor__" probe.
  --deep               Opt in to a real memory-store read probe. Default off
                       so doctor is cheap to run in CI / on first install.

Exit codes:
  0  no "fail" results
  1  at least one "fail" result (warnings do not affect exit code)

Examples:
  opencontext doctor
  opencontext doctor --json
  opencontext doctor --section memory-store
  opencontext doctor --section runtime --verbose
  opencontext doctor --deep                       # opt-in memory read probe
  opencontext doctor --user alice                 # policy probe as alice
  opencontext doctor --section distill            # check entity extractor wiring
  opencontext doctor --section bogus              # unknown → warn, exit 0`);
}

// ─── Renderer ──────────────────────────────────────────────────────────────

/** Render the doctor output in human-readable form. */
export function renderHuman(results: CheckResult[], verbose: boolean): string {
	const lines: string[] = ["[opencontext/doctor]"];
	const grouped = new Map<string, CheckResult[]>();
	for (const r of results) {
		const arr = grouped.get(r.section) ?? [];
		arr.push(r);
		grouped.set(r.section, arr);
	}
	// Stable order: known sections in declared order, then unknown sections.
	const orderedSections: string[] = [];
	for (const name of SECTION_NAMES) {
		if (grouped.has(name)) orderedSections.push(name);
	}
	for (const section of grouped.keys()) {
		if (!orderedSections.includes(section)) orderedSections.push(section);
	}
	for (const section of orderedSections) {
		lines.push(section);
		for (const r of grouped.get(section) ?? []) {
			if (!verbose && r.status === "ok") continue;
			const glyph = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
			lines.push(`  ${glyph} ${r.name}  ${r.detail}`);
		}
	}
	const passed = results.filter((r) => r.status === "ok").length;
	const warned = results.filter((r) => r.status === "warn").length;
	const failed = results.filter((r) => r.status === "fail").length;
	lines.push("");
	lines.push(`Summary: ${passed} passed, ${warned} warn, ${failed} failed`);
	return lines.join("\n");
}

/** Render the doctor output as a stable JSON envelope. */
export function renderJson(results: CheckResult[], exit: number): string {
	const envelope: DoctorOutput = {
		ok: !results.some((r) => r.status === "fail"),
		exit,
		results,
	};
	return JSON.stringify(envelope, null, 2);
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Run the doctor with the given options. Returns the exit code (0 = ok, 1 = fail).
 * Mutates nothing on disk; even the optional `--deep` memory probe only opens
 * a sqlite handle, runs a single lexical search for the synthetic
 * `__healthcheck__` keyword, then closes immediately.
 */
export async function runDoctor(opts: DoctorOptions): Promise<number> {
	const ctx: DoctorContext = {
		homeDir: opts.homeDir ?? homedir(),
		userId: opts.userId ?? "__doctor__",
		deep: opts.deep ?? false,
	};

	const results: CheckResult[] = [];
	if (opts.section && !isKnownSection(opts.section)) {
		results.push({
			section: "doctor",
			name: "section-name",
			status: "warn",
			detail: `unknown section: ${opts.section}`,
		});
	} else {
		const runners = pickRunners(opts.section);
		for (const run of runners) {
			try {
				const sectionResults = await run(ctx);
				results.push(...sectionResults);
			} catch (err) {
				results.push({
					section: opts.section ?? "doctor",
					name: "section-error",
					status: "fail",
					detail: `unexpected throw: ${errMessage(err)}`,
				});
			}
		}
	}

	const exit = results.some((r) => r.status === "fail") ? 1 : 0;

	if (opts.json) {
		console.log(renderJson(results, exit));
	} else {
		console.log(renderHuman(results, opts.verbose ?? false));
	}

	return exit;
}

function isKnownSection(name: string): name is SectionName {
	return (SECTION_NAMES as readonly string[]).includes(name);
}

function pickRunners(section?: string): SectionRunner[] {
	if (!section) return Object.values(SECTIONS);
	return [SECTIONS[section as SectionName]];
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// ─── 1. runtime ────────────────────────────────────────────────────────────

export function checkRuntime(_ctx: DoctorContext): Promise<CheckResult[]> {
	return Promise.resolve([checkNodeVersion(), checkPackageVersion()]);
}

function checkNodeVersion(): CheckResult {
	const v = process.versions.node;
	const major = Number.parseInt(v.split(".")[0] ?? "0", 10);
	if (!Number.isFinite(major) || major < 18) {
		return {
			section: "runtime",
			name: "node-version",
			status: "fail",
			detail: `v${v} (Node < 18 is unsupported)`,
		};
	}
	return {
		section: "runtime",
		name: "node-version",
		status: "ok",
		detail: `v${v}`,
	};
}

function checkPackageVersion(): CheckResult {
	// The facade's package.json sits two hops above `…/dist/cli/doctor.js`
	// (built) or `…/src/cli/doctor.ts` (vitest). Walk up to it via
	// `import.meta.url`, then look for the first `package.json` whose
	// `name` matches the facade. This is robust across tsx / vitest /
	// tsup bundling shapes — the runtime is ESM, so `__filename` is
	// not available as a fallback.
	const expectedName = "@melandlabs/opencontext";
	const start = fileURLToPath(import.meta.url);
	let dir = dirname(start);
	let version: string | null = null;
	for (let hops = 0; hops < 6; hops += 1) {
		const candidate = join(dir, "package.json");
		try {
			const raw = readFileSync(candidate, "utf8");
			const pkg = JSON.parse(raw) as { name?: string; version?: string };
			if (pkg?.name === expectedName && typeof pkg.version === "string") {
				version = pkg.version;
				break;
			}
		} catch {
			// Keep walking up — `package.json` may not exist at this level
			// (e.g. a partial checkout, or a transitively-installed copy
			// whose layout differs from the workspace).
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	if (version === null) {
		return {
			section: "runtime",
			name: "package-version",
			status: "warn",
			detail: `unable to read ${expectedName}/package.json near ${start}`,
		};
	}
	return {
		section: "runtime",
		name: "package-version",
		status: "ok",
		detail: version,
	};
}

// ─── 2. filesystem ────────────────────────────────────────────────────────

export function checkFilesystem(ctx: DoctorContext): Promise<CheckResult[]> {
	return Promise.resolve([
		checkHomeWritable(ctx.homeDir),
		checkSubdir(ctx.homeDir, "loop"),
		checkSubdir(ctx.homeDir, "memory"),
		checkSubdir(ctx.homeDir, "logs"),
	]);
}

function checkHomeWritable(homeDir: string): CheckResult {
	try {
		accessSync(homeDir, constants.W_OK);
		return {
			section: "filesystem",
			name: "home",
			status: "ok",
			detail: homeDir,
		};
	} catch (err) {
		return {
			section: "filesystem",
			name: "home",
			status: "fail",
			detail: `${homeDir} is not writable (${errMessage(err)})`,
		};
	}
}

function checkSubdir(homeDir: string, leaf: string): CheckResult {
	const target = join(homeDir, APP_DIR_NAME, leaf);
	if (!existsSync(target)) {
		return {
			section: "filesystem",
			name: `${leaf}-dir`,
			status: "warn",
			detail: `${target} does not exist — will be created on first use`,
		};
	}
	try {
		accessSync(target, constants.W_OK);
		return {
			section: "filesystem",
			name: `${leaf}-dir`,
			status: "ok",
			detail: target,
		};
	} catch (err) {
		return {
			section: "filesystem",
			name: `${leaf}-dir`,
			status: "fail",
			detail: `${target} is not writable (${errMessage(err)})`,
		};
	}
}

// ─── 3. loop ───────────────────────────────────────────────────────────────

export function checkLoop(_ctx: DoctorContext): Promise<CheckResult[]> {
	return Promise.resolve([checkLoopPreferences(), checkLoopCli()]);
}

function checkLoopPreferences(): CheckResult {
	try {
		const prefs = readPreferences();
		return {
			section: "loop",
			name: "preferences",
			status: "ok",
			detail: `enabled=${prefs.enabled}, briefTime=${String(prefs.briefTime)}`,
		};
	} catch (err) {
		return {
			section: "loop",
			name: "preferences",
			status: "fail",
			detail: `readPreferences threw: ${errMessage(err)}`,
		};
	}
}

/**
 * Test seam: pass a custom `moduleUrl` to override the `import.meta.url`
 * used for npm-bundle detection. The public `checkLoop()` path leaves it
 * empty so real invocations use the actual module location.
 */
export function checkLoopCli(moduleUrl: string = import.meta.url): CheckResult {
	try {
		const cliPath = resolveLoopCli();
		if (cliPath) {
			return {
				section: "loop",
				name: "loop-cli",
				status: "ok",
				detail: cliPath,
			};
		}

		// The shim is only shipped with the host app (Tauri / Next.js standalone /
		// dev workspace). The published npm bundle does not include loop-cli.mjs,
		// so npx users should not see a warning they cannot fix.
		if (isPublishedNpmBundle(moduleUrl)) {
			return {
				section: "loop",
				name: "loop-cli",
				status: "ok",
				detail: "not bundled in npm package — loop engine runs in host app",
			};
		}

		// Surface the candidates the resolver *did* consider so the user can
		// set OPENCONTEXT_LOOP_CLI to one of them, mirroring PowerContext's
		// `loop doctor` UX.
		const candidates = listLoopCliCandidates()
			.filter((c) => c.exists)
			.slice(0, 3);
		const extra =
			candidates.length > 0 ? ` (candidates tried: ${candidates.map((c) => c.path).join(", ")})` : "";
		return {
			section: "loop",
			name: "loop-cli",
			status: "warn",
			detail: `not found; set OPENCONTEXT_LOOP_CLI=/path/to/loop-cli.mjs${extra}`,
		};
	} catch (err) {
		return {
			section: "loop",
			name: "loop-cli",
			status: "warn",
			detail: `resolveLoopCli threw: ${errMessage(err)}`,
		};
	}
}

/**
 * Detect whether this doctor module is running from the published npm bundle.
 * npm / pnpm / yarn all place the package under `node_modules/@melandlabs/opencontext`,
 * whereas dev/workspace/host-app builds run from `packages/opencontext/...` or
 * `.next/standalone/...`.
 */
function isPublishedNpmBundle(moduleUrl: string = import.meta.url): boolean {
	try {
		const here = fileURLToPath(moduleUrl);
		return /node_modules[/\\]@melandlabs[/\\]opencontext(?:[/\\]|$)/.test(here);
	} catch {
		return false;
	}
}

// ─── 4. memory-store ──────────────────────────────────────────────────────

export async function checkMemoryStore(ctx: DoctorContext): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const backend = safeGetBackend();
	results.push({
		section: "memory-store",
		name: "backend",
		status: backend === "sqlite" || backend === "postgres" ? "ok" : "fail",
		detail: backend,
	});

	const available = safeIsAvailable();
	results.push({
		section: "memory-store",
		name: "available",
		status: available ? "ok" : "fail",
		detail: available ? "yes" : "no",
	});

	if (backend === "postgres") {
		const hasFactory = safeHasPostgresFactory();
		results.push({
			section: "memory-store",
			name: "postgres-factory",
			status: hasFactory ? "ok" : "fail",
			detail: hasFactory ? "registered" : "no Postgres factory is registered",
		});
	}

	try {
		const sqlitePath = resolveSQLiteRawMessageDbPath();
		results.push({
			section: "memory-store",
			name: "sqlite-path",
			status: "ok",
			detail: sqlitePath,
		});
	} catch (err) {
		results.push({
			section: "memory-store",
			name: "sqlite-path",
			status: "warn",
			detail: `resolveSQLiteRawMessageDbPath threw: ${errMessage(err)}`,
		});
	}

	if (ctx.deep) {
		const deepResult = await probeMemoryStoreRead(ctx);
		results.push(deepResult);
	}

	return results;
}

function safeGetBackend(): string {
	try {
		return getRawMessageStorageBackend();
	} catch {
		return "unknown";
	}
}

function safeIsAvailable(): boolean {
	try {
		return isRawMessageStorageAvailable();
	} catch {
		return false;
	}
}

function safeHasPostgresFactory(): boolean {
	try {
		return hasPostgresFactory();
	} catch {
		return false;
	}
}

async function probeMemoryStoreRead(ctx: DoctorContext): Promise<CheckResult> {
	// Lazy-import the dynamic manager so a probe failure never blocks the
	// rest of the doctor output (e.g. when the file is locked or sqlite
	// can't init).
	try {
		// `getRawMessageManager` is intentionally NOT used here — that
		// would route through the legacy module-level singleton and could
		// leak the open handle on assertion failures. We open a fresh
		// sqlite handle, run the probe, then `closeRawMessageStore()`
		// cleans up the singleton ref.
		const { createRawMessageStore } = await import("@melandlabs/memory-store");
		const store = createRawMessageStore({ env: undefined });
		const manager = await store.getManager();
		let resultCount = 0;
		if (typeof manager.lexicalSearchMessages === "function") {
			const rows = (await manager.lexicalSearchMessages({
				userId: ctx.userId,
				keywords: ["__healthcheck__"],
				limit: 1,
			})) as unknown[];
			resultCount = rows.length;
		} else {
			// Without the lexical probe, the manager is reachable but the
			// schema can't answer a kw query on this backend — surface as
			// warn so the user can decide.
			await closeRawMessageStore().catch(() => undefined);
			return {
				section: "memory-store",
				name: "deep-probe",
				status: "warn",
				detail: "manager exposes no lexicalSearchMessages; skipped read probe",
			};
		}
		await closeRawMessageStore().catch(() => undefined);
		return {
			section: "memory-store",
			name: "deep-probe",
			status: "ok",
			detail: `lexical search returned ${resultCount} row(s)`,
		};
	} catch (err) {
		await closeRawMessageStore().catch(() => undefined);
		return {
			section: "memory-store",
			name: "deep-probe",
			status: "warn",
			detail: `memory read probe failed: ${errMessage(err)}`,
		};
	}
}

// ─── 5. embedding ─────────────────────────────────────────────────────────

export function checkEmbedding(): Promise<CheckResult[]> {
	return Promise.resolve([checkEmbeddingProviderType(), checkEmbeddingModelName(), checkOpenRouterApiKey()]);
}

function checkEmbeddingProviderType(): CheckResult {
	try {
		const t = getEmbeddingProviderType();
		const valid = t === "cloud" || t === "local";
		return {
			section: "embedding",
			name: "provider-type",
			status: valid ? "ok" : "fail",
			detail: t,
		};
	} catch (err) {
		return {
			section: "embedding",
			name: "provider-type",
			status: "fail",
			detail: `getEmbeddingProviderType threw: ${errMessage(err)}`,
		};
	}
}

function checkEmbeddingModelName(): CheckResult {
	try {
		const model = getConfiguredEmbeddingModelName();
		return {
			section: "embedding",
			name: "model-name",
			status: model.length > 0 ? "ok" : "warn",
			detail: model.length > 0 ? model : "empty — check EMBEDDING_MODEL / LOCAL_EMBEDDING_MODEL",
		};
	} catch (err) {
		return {
			section: "embedding",
			name: "model-name",
			status: "warn",
			detail: `getConfiguredEmbeddingModelName threw: ${errMessage(err)}`,
		};
	}
}

function checkOpenRouterApiKey(): CheckResult {
	const usingCloud = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() === "cloud";
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!usingCloud) {
		return {
			section: "embedding",
			name: "openrouter-key",
			status: "ok",
			detail: "n/a (local provider)",
		};
	}
	if (!apiKey) {
		return {
			section: "embedding",
			name: "openrouter-key",
			status: "warn",
			detail: "OPENROUTER_API_KEY not set",
		};
	}
	return {
		section: "embedding",
		name: "openrouter-key",
		status: "ok",
		detail: "set",
	};
}

// ─── 6. policies ──────────────────────────────────────────────────────────

export function checkPolicies(ctx: DoctorContext): Promise<CheckResult[]> {
	return Promise.resolve([probeMemoryGraphWritePolicy(ctx), probeMemoryGraphCorrectionPolicy(ctx)]);
}

function probeMemoryGraphWritePolicy(ctx: DoctorContext): CheckResult {
	try {
		const decision = resolveMemoryGraphWritePolicy(ctx.userId, process.env);
		return renderPolicyDecision("policies", "write-policy", decision.enabled, decision.reasonCodes);
	} catch (err) {
		return {
			section: "policies",
			name: "write-policy",
			status: "fail",
			detail: `resolveMemoryGraphWritePolicy threw: ${errMessage(err)}`,
		};
	}
}

function probeMemoryGraphCorrectionPolicy(ctx: DoctorContext): CheckResult {
	try {
		const decision = resolveMemoryGraphCorrectionPolicy(ctx.userId, process.env);
		return renderPolicyDecision("policies", "correction-policy", decision.enabled, decision.reasonCodes);
	} catch (err) {
		return {
			section: "policies",
			name: "correction-policy",
			status: "fail",
			detail: `resolveMemoryGraphCorrectionPolicy threw: ${errMessage(err)}`,
		};
	}
}

function renderPolicyDecision(
	section: "memory-store" | "policies",
	name: string,
	enabled: boolean,
	reasonCodes: readonly string[],
): CheckResult {
	const joined = reasonCodes.join(", ") || "no reason code";
	if (!enabled) {
		const isKillSwitch = reasonCodes.some((c) => c.endsWith("_kill_switch"));
		return {
			section,
			name,
			status: isKillSwitch ? "fail" : "ok",
			detail: joined,
		};
	}
	return {
		section,
		name,
		status: "ok",
		detail: joined,
	};
}

// ─── 7. audit ──────────────────────────────────────────────────────────────

export function checkAudit(ctx: DoctorContext): Promise<CheckResult[]> {
	return Promise.resolve([checkAuditParent(ctx.homeDir), checkAuditSmoke()]);
}

function checkAuditParent(homeDir: string): CheckResult {
	const target = join(homeDir, APP_DIR_NAME, "logs");
	if (!existsSync(target)) {
		// The audit logger creates this on first write, so an unwritable
		// parent is a *fail* (writes will silently no-op) but a missing
		// dir is *not* a fail on first install.
		return {
			section: "audit",
			name: "log-dir",
			status: "warn",
			detail: `${AUDIT_LOG_PATH} does not exist yet — will be created on first audit write`,
		};
	}
	try {
		accessSync(target, constants.W_OK);
		const filePath = join(target, "audit.jsonl");
		let sizeNote = "";
		if (existsSync(filePath)) {
			const stat = statSync(filePath);
			// The audit logger rotates at 10 MB; surface when we're
			// approaching that limit so the user knows truncation is
			// imminent. 10 MB → warn; > 10 MB → fail (rotation may have
			// failed mid-write in pathological cases).
			if (stat.size > 10 * 1024 * 1024) {
				return {
					section: "audit",
					name: "log-dir",
					status: "fail",
					detail: `${filePath} (${stat.size} bytes — exceeds 10 MB rotation threshold)`,
				};
			}
			if (stat.size > 5 * 1024 * 1024) {
				sizeNote = ` (${stat.size} bytes — next rotate is at 10 MB)`;
			}
		}
		return {
			section: "audit",
			name: "log-dir",
			status: "ok",
			detail: `${filePath}${sizeNote}`,
		};
	} catch (err) {
		return {
			section: "audit",
			name: "log-dir",
			status: "fail",
			detail: `${target} is not writable (${errMessage(err)})`,
		};
	}
}

function checkAuditSmoke(): CheckResult {
	try {
		const { total } = readAuditLogs({ limit: 1 });
		return {
			section: "audit",
			name: "read-smoke",
			status: "ok",
			detail: `${total} entr${total === 1 ? "y" : "ies"} on disk`,
		};
	} catch (err) {
		return {
			section: "audit",
			name: "read-smoke",
			status: "fail",
			detail: `readAuditLogs threw: ${errMessage(err)}`,
		};
	}
}

// ─── 8. security ──────────────────────────────────────────────────────────

export function checkSecurity(): Promise<CheckResult[]> {
	return Promise.resolve([checkEncryptionKey()]);
}

function checkEncryptionKey(): CheckResult {
	const raw = process.env.ENCRYPTION_KEY;
	if (!raw) {
		// OpenContext installs don't *require* an encryption key — most
		// hosts run without one. Warn so the user notices when they do
		// try to enable encryption downstream.
		return {
			section: "security",
			name: "encryption-key",
			status: "warn",
			detail: "ENCRYPTION_KEY not set",
		};
	}
	try {
		const decoded = Buffer.from(raw, "base64");
		if (decoded.length < 32) {
			return {
				section: "security",
				name: "encryption-key",
				status: "fail",
				detail: `decoded length ${decoded.length} bytes (need ≥ 32)`,
			};
		}
		return {
			section: "security",
			name: "encryption-key",
			status: "ok",
			detail: `${decoded.length} bytes after base64 decode`,
		};
	} catch (err) {
		return {
			section: "security",
			name: "encryption-key",
			status: "fail",
			detail: `could not base64-decode: ${errMessage(err)}`,
		};
	}
}

// ─── 9. integrations ──────────────────────────────────────────────────────

export function checkIntegrations(): Promise<CheckResult[]> {
	return Promise.resolve([
		checkIntegrationRegistry(),
		checkIntegrationRoundTrip(),
		checkTelegramCredentials(),
	]);
}

function checkIntegrationRegistry(): CheckResult {
	return {
		section: "integrations",
		name: "registry",
		status: "ok",
		detail: `${INTEGRATION_IDS.length} integration ids registered`,
	};
}

function checkIntegrationRoundTrip(): CheckResult {
	const sample = INTEGRATION_IDS[0];
	const accepted = isIntegrationId(sample);
	const rejected = isIntegrationId("not-a-real-platform");
	if (accepted && !rejected) {
		return {
			section: "integrations",
			name: "round-trip",
			status: "ok",
			detail: `isIntegrationId("${sample}") = true; "not-a-real-platform" = false`,
		};
	}
	return {
		section: "integrations",
		name: "round-trip",
		status: "fail",
		detail: `unexpected: accepted=${accepted}, rejected=${rejected}`,
	};
}

function checkTelegramCredentials(): CheckResult {
	const id = process.env.TG_APP_ID;
	const hash = process.env.TG_APP_HASH;
	if (id && hash) {
		return {
			section: "integrations",
			name: "telegram-creds",
			status: "ok",
			detail: "TG_APP_ID + TG_APP_HASH set",
		};
	}
	const missing: string[] = [];
	if (!id) missing.push("TG_APP_ID");
	if (!hash) missing.push("TG_APP_HASH");
	return {
		section: "integrations",
		name: "telegram-creds",
		status: "warn",
		detail: `${missing.join(" + ")} not set — telegram integration disabled`,
	};
}

// ─── 10. distill (entity extraction) ───────────────────────────────────────
//
// Surfaces whether the `distill` primitive has the deps it needs to
// extract from real messages. The host wires `unified.entityExtractor`
// from its own code path — the doctor cannot introspect the deps
// object — so we honour an `OPENCONTEXT_ENTITY_EXTRACTOR=1` env var
// as a host opt-in signal. When the env var is set but no extractor
// has been wired (e.g. host forgot), we warn about the
// `distill_extractor_not_configured` degradation path the SDK
// emits at runtime.

export function checkDistill(_ctx: DoctorContext): Promise<CheckResult[]> {
	const enabled = process.env.OPENCONTEXT_ENTITY_EXTRACTOR?.trim() === "1";
	if (!enabled) {
		return Promise.resolve([
			{
				section: "distill",
				name: "extractor",
				status: "ok",
				detail: "not enabled (set OPENCONTEXT_ENTITY_EXTRACTOR=1 to opt in)",
			},
		]);
	}
	return Promise.resolve([
		{
			section: "distill",
			name: "extractor",
			status: "warn",
			detail:
				"OPENCONTEXT_ENTITY_EXTRACTOR=1 but no runtime probe — ensure `unified.entityExtractor` is wired into your memory-store config, otherwise distill calls will return distill_extractor_not_configured.",
		},
	]);
}

// ─── 11. entity-search (entity sub-query for unified search) ───────────────
//
// Same opt-in pattern as `distill`. Without an entity sub-query
// wired in, the unified search falls back to semantic + lexical only;
// under RRF it additionally emits `memory_entity_search_not_configured`.

export function checkEntitySearch(_ctx: DoctorContext): Promise<CheckResult[]> {
	const enabled = process.env.OPENCONTEXT_ENTITY_SEARCH?.trim() === "1";
	if (!enabled) {
		return Promise.resolve([
			{
				section: "entity-search",
				name: "provider",
				status: "ok",
				detail: "not enabled (set OPENCONTEXT_ENTITY_SEARCH=1 to opt in)",
			},
		]);
	}
	return Promise.resolve([
		{
			section: "entity-search",
			name: "provider",
			status: "warn",
			detail:
				"OPENCONTEXT_ENTITY_SEARCH=1 but no runtime probe — ensure `unified.entitySearch` is wired into your memory-store config, otherwise RRF searches will surface memory_entity_search_not_configured.",
		},
	]);
}

// ─── 12. derive (fact derivation) ──────────────────────────────────────────
//
// Surfaces whether the `derive` primitive has the deps it needs to
// synthesize facts. Same opt-in env var convention as `distill`.

export function checkDerive(_ctx: DoctorContext): Promise<CheckResult[]> {
	const enabled = process.env.OPENCONTEXT_DERIVER?.trim() === "1";
	if (!enabled) {
		return Promise.resolve([
			{
				section: "derive",
				name: "deriver",
				status: "ok",
				detail: "not enabled (set OPENCONTEXT_DERIVER=1 to opt in)",
			},
		]);
	}
	return Promise.resolve([
		{
			section: "derive",
			name: "deriver",
			status: "warn",
			detail:
				"OPENCONTEXT_DERIVER=1 but no runtime probe — ensure `unified.deriver` is wired into your memory-store config, otherwise derive calls will return derive_deriver_not_configured.",
		},
	]);
}
