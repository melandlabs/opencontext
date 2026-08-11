/**
 * Claude Code CLI process spawner for `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK does not consume stderr when a custom spawner is supplied, so this
 * helper routes every Claude Code invocation through one registration
 * boundary that preserves Windows process-tree cancellation and drains
 * stderr through the bounded line sink before the caller redacts and logs it.
 *
 * The reference port strips the openloomi distribution-specific bundle
 * detection (legacy `cli-bundle/{sh,cmd}` wrappers + a `~/.openloomi/node`
 * fallback) — callers should configure `pathToClaudeCodeExecutable` to point
 * at the installed `claude` binary (or a custom path via `providerConfig`)
 * and rely on this helper only for cross-platform spawning quirks.
 */

import { type ChildProcess, type SpawnOptionsWithStdioTuple, exec, spawn } from "node:child_process";
import { platform } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { createLineBufferedDiagnosticSink } from "./runtime-preflight";

type ClaudeCodeProcessSpawner = NonNullable<Options["spawnClaudeCodeProcess"]>;
type ClaudeCodeSpawnInput = Parameters<ClaudeCodeProcessSpawner>[0];
type FullyPipedSpawnOptions = SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">;

/**
 * Bridge Node's `ChildProcess` to the SDK's `SpawnedProcess` shape. The two
 * types differ only in that `ChildProcess.{stdin,stdout,stderr}` are nullable
 * while the SDK expects the pipes to be present — `stdio: "pipe"` guarantees
 * that, but TypeScript can't see through the spawn call.
 */
function asSpawnedProcess(child: ChildProcess): SpawnedProcess {
	return child as unknown as SpawnedProcess;
}

/**
 * Build the spawner that the Claude Code SDK should use for child processes.
 *
 * `onDiagnosticLine` is invoked once per completed stderr line. Callers MUST
 * redact each line (see {@link redactClaudeRuntimeDiagnostic}) before
 * forwarding it to application logs — the SDK surfaces raw API errors here.
 */
export function createClaudeCodeProcessSpawner(
	onDiagnosticLine: (line: string) => void,
): ClaudeCodeProcessSpawner {
	return (options) => spawnClaudeCodeProcess(options, onDiagnosticLine);
}

function spawnClaudeCodeProcess(
	options: ClaudeCodeSpawnInput,
	onDiagnosticLine: (line: string) => void,
): SpawnedProcess {
	const os = platform();

	const registerWindowsTreeKill = (childProcess: ChildProcess) => {
		if (os === "win32" && childProcess.pid) {
			const signal = options.signal;
			const unregister = () => {
				signal?.removeEventListener("abort", killProcessTree);
				childProcess.off("exit", unregister);
				childProcess.off("close", unregister);
			};
			const killProcessTree = () => {
				unregister();
				exec(`taskkill /F /T /PID ${childProcess.pid}`, { windowsHide: true }, () => {
					// Ignore errors — the process may already be dead.
				});
			};

			signal?.addEventListener("abort", killProcessTree, { once: true });
			childProcess.once("exit", unregister);
			childProcess.once("close", unregister);
		}
	};

	const registerChildProcess = (childProcess: ChildProcess) => {
		registerWindowsTreeKill(childProcess);
		if (childProcess.stderr) {
			// A credential can straddle arbitrary stream chunks. Reassemble bounded
			// lines before forwarding them to the redacting diagnostic callback.
			const stderrSink = createLineBufferedDiagnosticSink(onDiagnosticLine);
			childProcess.stderr.on("data", (data: Buffer | string) => {
				stderrSink.write(data);
			});
			childProcess.stderr.once("end", () => stderrSink.end());
			childProcess.stderr.once("close", () => stderrSink.end());
		}
	};

	const asProcessEnv = (env: Record<string, string | undefined>): NodeJS.ProcessEnv =>
		env as NodeJS.ProcessEnv;

	let resolvedCwd = options.cwd;
	if (resolvedCwd && !isAbsolute(resolvedCwd)) {
		resolvedCwd = join(process.cwd(), resolvedCwd);
	}

	const spawnRegistered = (
		command: string,
		args: string[],
		env: Record<string, string | undefined>,
	): SpawnedProcess => {
		const spawnOptions: FullyPipedSpawnOptions = {
			cwd: resolvedCwd,
			env: asProcessEnv(env),
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
			windowsHide: true,
		};
		const childProcess = spawn(command, args, spawnOptions);
		registerChildProcess(childProcess);
		return asSpawnedProcess(childProcess);
	};

	// Shell-script wrappers (`claude.sh` / `claude.cmd`) cannot be spawned
	// directly on either platform — wrap them in `/bin/sh -c` (POSIX) or
	// `cmd.exe /c` (Windows). Unset the `CLAUDECODE` nesting marker so a
	// Claude Code process spawned inside a Claude Code parent does not
	// accidentally short-circuit.
	const isShellScript = options.command.endsWith(".sh") || options.command.endsWith(".cmd");
	if (isShellScript) {
		if (os === "win32") {
			return spawnRegistered("cmd.exe", ["/c", options.command, ...options.args], options.env);
		}
		return spawnRegistered(
			"/bin/sh",
			["-c", `unset CLAUDECODE && exec "$0" "$@"`, options.command, ...options.args],
			options.env,
		);
	}

	// Native `claude` / `claude.exe` — spawn directly, but still scrub the
	// nesting marker if the caller put one in `options.env`.
	const isNativeClaude = ["claude", "claude.exe"].includes(basename(options.command).toLowerCase());
	return spawnRegistered(
		options.command,
		options.args,
		isNativeClaude ? { ...options.env, CLAUDECODE: "" } : options.env,
	);
}
