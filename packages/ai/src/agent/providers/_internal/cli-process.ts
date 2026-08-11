/**
 * Shared CLI process helpers used by ACP-based and CLI-parser-based agent
 * providers (acp/, opencode/, codex/, hermes/, openclaw/).
 *
 * Centralises:
 *   - PATH lookup for packaged desktop environments
 *   - Least-privilege environment filtering for spawned agent CLIs
 *   - Bounded capture of stdout/stderr chunks
 *   - Cross-platform process-tree termination
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const terminatingProcesses = new WeakSet<ChildProcess>();
const POSIX_TERMINATION_GRACE_MS = 2_000;
export const MAX_CLI_PROTOCOL_LINE_CHARS = 16 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;
const DEFAULT_CLI_ENV_KEYS = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"TMP",
	"TEMP",
	"TMPDIR",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
]);
const RUNTIME_ENV_PREFIXES = ["OPENCODE_", "HERMES_", "OPENCLAW_", "CODEX_"];

/**
 * Allow deployments to opt additional env var names into the inherited CLI
 * environment. Comma-separated, case-insensitive. Keys with these prefixes
 * (RUNTIME_ENV_PREFIXES) are always inherited regardless of allowlist.
 */
export const AGENT_ENV_ALLOWLIST = "MELANDLABS_AGENT_ENV_ALLOWLIST";

export function shouldDetachCliProcess(): boolean {
	return platform() !== "win32";
}

/**
 * Desktop apps inherit a much shorter PATH than an interactive shell. Keep
 * runtime probes and actual CLI execution on the same search path so a CLI
 * reported as ready is also launchable when a task starts.
 */
export function buildAgentCliSearchPath(
	basePath = process.env.PATH ?? "",
	options: {
		platform?: NodeJS.Platform;
		homeDirectory?: string;
		localAppData?: string;
	} = {},
): string {
	const currentPlatform = options.platform ?? platform();
	const home = options.homeDirectory ?? homedir();
	const paths = basePath
		.split(delimiter)
		.map((entry) => entry.replace(/^"|"$/g, "").trim())
		.filter(Boolean);

	if (currentPlatform === "win32") {
		const localAppData =
			options.localAppData?.trim() || process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
		paths.push(
			join(home, ".local", "bin"),
			join(home, "AppData", "Roaming", "npm"),
			join(home, "AppData", "Local", "Programs", "nodejs"),
			join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
			join(home, ".volta", "bin"),
			"C:\\Program Files\\nodejs",
			"C:\\Program Files (x86)\\nodejs",
		);
	} else {
		paths.push(
			"/usr/local/bin",
			"/opt/homebrew/bin",
			join(home, ".local", "bin"),
			join(home, ".npm-global", "bin"),
			join(home, ".volta", "bin"),
			join(home, ".bun", "bin"),
			join(home, "Library", "pnpm"),
			join(home, ".local", "share", "pnpm"),
			join(home, "code", "node", "npm_global", "bin"),
		);

		const nvmDirectory = join(home, ".nvm", "versions", "node");
		try {
			if (existsSync(nvmDirectory)) {
				for (const version of readdirSync(nvmDirectory)) {
					paths.push(join(nvmDirectory, version, "bin"));
				}
			}
		} catch {
			// nvm is optional and may be unreadable in hardened desktop installs.
		}
	}

	return Array.from(new Set(paths)).join(delimiter);
}

/** Resolve commands in the same directory-first order used by PATH lookup. */
export function findCliExecutableOnSearchPath(
	searchPath: string,
	candidates: readonly string[],
): string | null {
	const directories = searchPath
		.split(delimiter)
		.map((directory) => directory.replace(/^"|"$/g, "").trim())
		.filter(Boolean);

	for (const directory of directories) {
		for (const candidate of candidates) {
			const command = join(directory, candidate);
			if (existsSync(command)) return command;
		}
	}

	return null;
}

/**
 * Build a least-privilege environment for local agent CLIs. Runtime-specific
 * and model credentials are preserved, while unrelated app/database/auth
 * secrets are not inherited. Deployments can opt additional names in via
 * {@link AGENT_ENV_ALLOWLIST}.
 */
export function buildCliEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
	const extraKeys = new Set(
		(process.env[AGENT_ENV_ALLOWLIST] ?? "")
			.split(",")
			.map((key) => key.trim().toUpperCase())
			.filter(Boolean),
	);
	const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };

	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const normalizedKey = key.toUpperCase();
		if (
			DEFAULT_CLI_ENV_KEYS.has(normalizedKey) ||
			extraKeys.has(normalizedKey) ||
			RUNTIME_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
		) {
			env[key] = value;
		}
	}

	return { ...env, ...overrides };
}

export function appendCapturedCliOutput(current: string, chunk: string): string {
	const combined = current + chunk;
	return combined.length <= MAX_CAPTURED_OUTPUT_CHARS ? combined : combined.slice(-MAX_CAPTURED_OUTPUT_CHARS);
}

/**
 * Stop the CLI and descendants it launched. POSIX children are spawned as a
 * process-group leader so a disconnect cannot leave tool processes running.
 */
export function terminateCliProcessTree(proc: ChildProcess): void {
	if (terminatingProcesses.has(proc) || proc.exitCode !== null || proc.signalCode !== null) {
		return;
	}
	terminatingProcesses.add(proc);

	if (platform() === "win32" && proc.pid) {
		spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
			windowsHide: true,
			stdio: "ignore",
		}).on("error", () => {
			proc.kill();
		});
		return;
	}

	signalPosixProcessGroup(proc, "SIGTERM");
	const forceKillTimer = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			signalPosixProcessGroup(proc, "SIGKILL");
		}
	}, POSIX_TERMINATION_GRACE_MS);
	forceKillTimer.unref();
	proc.once("close", () => clearTimeout(forceKillTimer));
}

function signalPosixProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (proc.pid) {
			process.kill(-proc.pid, signal);
		} else {
			proc.kill(signal);
		}
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// The process exited between the state check and the signal.
		}
	}
}
