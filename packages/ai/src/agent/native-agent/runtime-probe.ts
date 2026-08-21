/**
 * Server-side readiness probes for the local Claude Code and Codex CLIs.
 *
 * Probes are deliberately read-only: they check the executable version and
 * the CLI's own authentication status without starting a model request. Raw
 * probe output stays server-side; UI routes must translate these structures
 * into the safe summary exported by `runtime-settings.ts`.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, parse } from "node:path";
import spawn from "cross-spawn";

import {
	appendCapturedCliOutput,
	buildAgentCliSearchPath,
	buildCliEnvironment,
	findCliExecutableOnSearchPath,
	shouldDetachCliProcess,
	terminateCliProcessTree,
} from "../providers/_internal/cli-process";
import { getClaudeBundleDirectories } from "../providers/claude/cli-locations";

// App-data directory name (under `$HOME`) where the host's desktop build
// stages bundled CLI binaries. Hosts can override via
// `OPENCONTEXT_APP_DIR_NAME`; the runtime probe defaults to a neutral value
// so server-only consumers still resolve the same codex/claude binaries
// regardless of where they run.
const APP_DIR_NAME = process.env.OPENCONTEXT_APP_DIR_NAME || "opencontext";

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

const PROBE_CREDENTIAL_KEYS = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
]);
const PROBE_RUNTIME_PREFIXES = ["OPENCODE_", "HERMES_", "OPENCLAW_", "CODEX_"];

export type NativeRuntimeStatus =
	| "CLAUDE_CLI_AUTHENTICATED"
	| "CLAUDE_CLI_AUTH_REQUIRED"
	| "CLAUDE_CLI_AUTH_STATUS_TIMEOUT"
	| "CLAUDE_CLI_AUTH_STATUS_UNAVAILABLE"
	| "CLAUDE_CLI_VERSION_FAILED"
	| "CLAUDE_CLI_VERSION_TIMEOUT"
	| "CLAUDE_CLI_UNAVAILABLE";

export type CodexRuntimeStatus =
	| "CODEX_CLI_AUTHENTICATED"
	| "CODEX_CLI_AUTH_REQUIRED"
	| "CODEX_CLI_AUTH_STATUS_TIMEOUT"
	| "CODEX_CLI_AUTH_STATUS_UNAVAILABLE"
	| "CODEX_CLI_VERSION_FAILED"
	| "CODEX_CLI_VERSION_TIMEOUT"
	| "CODEX_CLI_UNAVAILABLE";

export type ProbeResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	error: { code: string; message: string } | null;
	elapsedMs: number;
	timedOut: boolean;
};

type CliPathSource =
	| "BUNDLED"
	| "PATH"
	| "CLAUDE_CODE_PATH"
	| "OPENCONTEXT_AGENT_CODEX_COMMAND"
	| "FALLBACK"
	| null;

type BaseRuntimeProbe<Provider extends "claude" | "codex", Status extends string> = {
	checked: true;
	provider: Provider;
	available: boolean;
	authenticated: boolean;
	active: boolean;
	ready: boolean;
	reason: Status;
	cliPathPresent: boolean;
	cliPathSource: CliPathSource;
	versionPresent: boolean;
	version: string | null;
	probes: {
		version?: ProbeResult;
		auth?: ProbeResult;
	};
};

export type NativeRuntimeProbe = BaseRuntimeProbe<"claude", NativeRuntimeStatus> & {
	// Kept for the existing `/api/preferences/ai` plugin contract.
	defaultAgent: "claude";
};

export type CodexRuntimeProbe = BaseRuntimeProbe<"codex", CodexRuntimeStatus>;

type RuntimeDefinition<Provider extends "claude" | "codex", Status extends string> = {
	provider: Provider;
	binary: Provider;
	explicitCommand: string | undefined;
	explicitSource: Exclude<CliPathSource, null>;
	authArgs: readonly string[];
	status: {
		ready: Status;
		authRequired: Status;
		authTimeout: Status;
		authUnavailable: Status;
		versionFailed: Status;
		versionTimeout: Status;
		unavailable: Status;
	};
};

type ResolvedCliPath = {
	path: string | null;
	source: CliPathSource;
	searchPath: string;
	argsPrefix: string[];
};

let claudeCache: { at: number; value: NativeRuntimeProbe } | null = null;
let codexCache: { at: number; value: CodexRuntimeProbe } | null = null;
let claudeInFlight: Promise<NativeRuntimeProbe> | null = null;
let codexInFlight: Promise<CodexRuntimeProbe> | null = null;

function candidateBinaries(binary: string): string[] {
	if (platform() === "win32") {
		return [`${binary}.exe`, `${binary}.cmd`, binary];
	}
	return [binary];
}

/** Resolve both current native bundles and legacy cli.js bundles. */
function resolveBundledClaudeCommand(): {
	path: string;
	argsPrefix: string[];
} | null {
	const executable = platform() === "win32" ? "claude.exe" : "claude";

	for (const directory of getClaudeBundleDirectories()) {
		const candidate = join(directory, executable);
		if (existsSync(candidate)) return { path: candidate, argsPrefix: [] };

		const cliPath = join(directory, "cli.js");
		const vendorDirectory = join(directory, "vendor");
		if (!(existsSync(cliPath) && existsSync(vendorDirectory))) continue;

		const bundledNode = join(directory, platform() === "win32" ? "node.exe" : "node");
		const openLoomiNode = join(homedir(), APP_DIR_NAME, "node", "node.exe");
		const nodePath = existsSync(bundledNode)
			? bundledNode
			: platform() === "win32" && existsSync(openLoomiNode)
				? openLoomiNode
				: "node";
		return {
			path: nodePath,
			argsPrefix: ["--max-old-space-size=8192", cliPath],
		};
	}
	return null;
}

function isBareCommand(command: string): boolean {
	const parsed = parse(command);
	return parsed.dir.length === 0 && parsed.base === command;
}

function resolveCliPath(definition: RuntimeDefinition<"claude" | "codex", string>): ResolvedCliPath {
	const searchPath = buildAgentCliSearchPath();

	if (definition.provider === "claude") {
		const bundled = resolveBundledClaudeCommand();
		if (bundled) {
			return { ...bundled, source: "BUNDLED", searchPath };
		}
	}

	const explicit = definition.explicitCommand?.trim();
	if (explicit) {
		if (existsSync(explicit) || isBareCommand(explicit)) {
			return {
				path: explicit,
				source: definition.explicitSource,
				searchPath,
				argsPrefix: [],
			};
		}
	}

	const pathCommand = findCliExecutableOnSearchPath(searchPath, candidateBinaries(definition.binary));
	if (pathCommand) {
		return {
			path: pathCommand,
			source: "PATH",
			searchPath,
			argsPrefix: [],
		};
	}

	return { path: null, source: null, searchPath, argsPrefix: [] };
}

function runCli(
	provider: "claude" | "codex",
	command: string,
	args: readonly string[],
	timeoutMs: number,
	searchPath: string,
	argsPrefix: readonly string[] = [],
): Promise<ProbeResult> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const settle = (result: ProbeResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		let processHandle: ChildProcess;
		try {
			processHandle = spawn(command, [...argsPrefix, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: shouldDetachCliProcess(),
				env: buildRuntimeProbeEnvironment(provider, {
					PATH: searchPath,
					CLAUDECODE: "",
				}),
				windowsHide: true,
			});
		} catch (error) {
			settle({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				error: {
					code: "SPAWN_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
				elapsedMs: Date.now() - startedAt,
				timedOut: false,
			});
			return;
		}

		processHandle.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendCapturedCliOutput(stdout, chunk.toString());
		});
		processHandle.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendCapturedCliOutput(stderr, chunk.toString());
		});

		timer = setTimeout(() => {
			terminateCliProcessTree(processHandle);
			settle({
				ok: false,
				stdout,
				stderr,
				exitCode: processHandle.exitCode,
				error: null,
				elapsedMs: Date.now() - startedAt,
				timedOut: true,
			});
		}, timeoutMs);

		processHandle.once("error", (error) => {
			settle({
				ok: false,
				stdout,
				stderr,
				exitCode: null,
				error: { code: "SPAWN_FAILED", message: error.message },
				elapsedMs: Date.now() - startedAt,
				timedOut: false,
			});
		});

		processHandle.once("close", (code) => {
			settle({
				ok: code === 0,
				stdout,
				stderr,
				exitCode: code,
				error: null,
				elapsedMs: Date.now() - startedAt,
				timedOut: false,
			});
		});
	});
}

function buildRuntimeProbeEnvironment(
	provider: "claude" | "codex",
	overrides: Record<string, string>,
): NodeJS.ProcessEnv {
	const providerOverrides: Record<string, string> = {};
	if (provider === "claude") {
		for (const key of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_CODE_OAUTH_TOKEN",
		]) {
			const value = process.env[key];
			if (value !== undefined) providerOverrides[key] = value;
		}
	}

	const env = buildCliEnvironment({ ...providerOverrides, ...overrides });
	for (const key of Object.keys(env)) {
		const normalized = key.toUpperCase();
		const isRuntimeCredential =
			PROBE_CREDENTIAL_KEYS.has(normalized) ||
			PROBE_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
		if (!isRuntimeCredential) continue;

		const isProviderCredential =
			provider === "claude"
				? normalized.startsWith("ANTHROPIC_") ||
					normalized === "CLAUDE_CONFIG_DIR" ||
					normalized === "CLAUDE_CODE_OAUTH_TOKEN"
				: normalized === "OPENAI_API_KEY" || normalized.startsWith("CODEX_");
		if (!isProviderCredential) {
			delete env[key];
		}
	}
	return env;
}

function cleanVersion(result: ProbeResult): string | null {
	const line = `${result.stdout}\n${result.stderr}`
		.split(/\r?\n/)
		.map((value) => value.trim())
		.find(Boolean);
	if (!line) return null;
	// Only publish the semantic version token. A CLI can print warnings,
	// usernames, or local paths around it; those details stay server-side.
	return line.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function isAuthCommandUnavailable(result: ProbeResult): boolean {
	const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
	return (
		combined.includes("unknown command") ||
		combined.includes("unrecognized subcommand") ||
		combined.includes("invalid command")
	);
}

async function probeCliRuntime<Provider extends "claude" | "codex", Status extends string>(
	definition: RuntimeDefinition<Provider, Status>,
) {
	const resolved = resolveCliPath(definition as RuntimeDefinition<"claude" | "codex", string>);
	const base = { checked: true as const, provider: definition.provider };

	if (!resolved.path) {
		return {
			...base,
			available: false,
			authenticated: false,
			active: false,
			ready: false,
			reason: definition.status.unavailable,
			cliPathPresent: false,
			cliPathSource: null,
			versionPresent: false,
			version: null,
			probes: {},
		};
	}

	const versionProbe = await runCli(
		definition.provider,
		resolved.path,
		["--version"],
		PROBE_TIMEOUT_MS,
		resolved.searchPath,
		resolved.argsPrefix,
	);
	if (!versionProbe.ok) {
		const result = {
			...base,
			available: true,
			authenticated: false,
			active: false,
			ready: false,
			reason: versionProbe.timedOut ? definition.status.versionTimeout : definition.status.versionFailed,
			cliPathPresent: true,
			cliPathSource: resolved.source,
			versionPresent: false,
			version: null,
			probes: { version: versionProbe },
		};
		console.warn(`[NativeAgentRuntime] ${definition.provider} version probe failed: ${result.reason}`);
		return result;
	}

	const authProbe = await runCli(
		definition.provider,
		resolved.path,
		definition.authArgs,
		PROBE_TIMEOUT_MS,
		resolved.searchPath,
		resolved.argsPrefix,
	);
	if (!authProbe.ok) {
		const reason = authProbe.timedOut
			? definition.status.authTimeout
			: isAuthCommandUnavailable(authProbe)
				? definition.status.authUnavailable
				: definition.status.authRequired;
		return {
			...base,
			available: true,
			authenticated: false,
			active: false,
			ready: false,
			reason,
			cliPathPresent: true,
			cliPathSource: resolved.source,
			versionPresent: true,
			version: cleanVersion(versionProbe),
			probes: { version: versionProbe, auth: authProbe },
		};
	}

	return {
		...base,
		available: true,
		authenticated: true,
		active: true,
		ready: true,
		reason: definition.status.ready,
		cliPathPresent: true,
		cliPathSource: resolved.source,
		versionPresent: true,
		version: cleanVersion(versionProbe),
		probes: { version: versionProbe, auth: authProbe },
	};
}

export async function probeNativeClaudeRuntime(
	options: { force?: boolean } = {},
): Promise<NativeRuntimeProbe | null> {
	if (!options.force && claudeCache && Date.now() - claudeCache.at < CACHE_TTL_MS) {
		return claudeCache.value;
	}
	if (claudeInFlight) return claudeInFlight;

	const operation = probeCliRuntime({
		provider: "claude",
		binary: "claude",
		explicitCommand: process.env.CLAUDE_CODE_PATH,
		explicitSource: "CLAUDE_CODE_PATH",
		authArgs: ["auth", "status"],
		status: {
			ready: "CLAUDE_CLI_AUTHENTICATED",
			authRequired: "CLAUDE_CLI_AUTH_REQUIRED",
			authTimeout: "CLAUDE_CLI_AUTH_STATUS_TIMEOUT",
			authUnavailable: "CLAUDE_CLI_AUTH_STATUS_UNAVAILABLE",
			versionFailed: "CLAUDE_CLI_VERSION_FAILED",
			versionTimeout: "CLAUDE_CLI_VERSION_TIMEOUT",
			unavailable: "CLAUDE_CLI_UNAVAILABLE",
		},
	}).then((result) => {
		const probe: NativeRuntimeProbe = { ...result, defaultAgent: "claude" };
		claudeCache = { at: Date.now(), value: probe };
		return probe;
	});
	claudeInFlight = operation;
	try {
		return await operation;
	} finally {
		if (claudeInFlight === operation) claudeInFlight = null;
	}
}

export async function probeNativeCodexRuntime(
	options: { force?: boolean } = {},
): Promise<CodexRuntimeProbe | null> {
	if (!options.force && codexCache && Date.now() - codexCache.at < CACHE_TTL_MS) {
		return codexCache.value;
	}
	if (codexInFlight) return codexInFlight;

	const operation = probeCliRuntime({
		provider: "codex",
		binary: "codex",
		explicitCommand: process.env.OPENCONTEXT_AGENT_CODEX_COMMAND,
		explicitSource: "OPENCONTEXT_AGENT_CODEX_COMMAND",
		authArgs: ["login", "status"],
		status: {
			ready: "CODEX_CLI_AUTHENTICATED",
			authRequired: "CODEX_CLI_AUTH_REQUIRED",
			authTimeout: "CODEX_CLI_AUTH_STATUS_TIMEOUT",
			authUnavailable: "CODEX_CLI_AUTH_STATUS_UNAVAILABLE",
			versionFailed: "CODEX_CLI_VERSION_FAILED",
			versionTimeout: "CODEX_CLI_VERSION_TIMEOUT",
			unavailable: "CODEX_CLI_UNAVAILABLE",
		},
	}).then((result) => {
		codexCache = { at: Date.now(), value: result };
		return result;
	});
	codexInFlight = operation;
	try {
		return await operation;
	} finally {
		if (codexInFlight === operation) codexInFlight = null;
	}
}

export function clearNativeClaudeRuntimeCache(): void {
	claudeCache = null;
}

export function clearNativeCodexRuntimeCache(): void {
	codexCache = null;
}

export function clearNativeRuntimeCaches(): void {
	clearNativeClaudeRuntimeCache();
	clearNativeCodexRuntimeCache();
}

export function getRuntimePlatform(): "windows" | "macos" | "linux" {
	if (platform() === "win32") return "windows";
	if (platform() === "darwin") return "macos";
	return "linux";
}
