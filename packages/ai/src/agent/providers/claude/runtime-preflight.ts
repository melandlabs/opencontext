/**
 * Claude Code runtime preflight utilities.
 *
 * Shared helpers used by both the Claude Agent SDK process spawner and the
 * SDK's stderr diagnostic pipeline. Keeping them here lets the ClaudeAgent
 * subclass focus on wire-up while this module owns the platform quirks
 * (temp-directory mode bits, line-buffered stderr reassembly, credential
 * redaction in diagnostics).
 */

import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { StringDecoder } from "node:string_decoder";

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_DIAGNOSTIC_LINE_LENGTH = 64 * 1024;
const OVERSIZED_DIAGNOSTIC_PLACEHOLDER = "[stderr line omitted: exceeds diagnostic limit]\n";

/**
 * Ensure Claude Code's configured temp directory is usable and private.
 *
 * Claude Code materializes inline `--settings` JSON in this directory before
 * startup. If the directory is missing or unsafe, the native runtime exits
 * with code 1 before emitting its init message. Removing an unusable override
 * lets the runtime fall back to the operating system temp directory.
 */
export async function prepareClaudeCodeTempDirectory(
	env: Record<string, string | undefined>,
): Promise<Error | null> {
	const directory = env.CLAUDE_CODE_TMPDIR;
	if (!directory?.trim()) {
		// biome-ignore lint/performance/noDelete: the child environment must omit this key; assigning undefined can be stringified by process.env.
		delete env.CLAUDE_CODE_TMPDIR;
		return null;
	}

	try {
		await mkdir(directory, {
			recursive: true,
			mode: PRIVATE_DIRECTORY_MODE,
		});

		const stats = await lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error("configured path is not a real directory");
		}

		const currentUid = process.getuid?.();
		if (currentUid !== undefined && stats.uid !== currentUid) {
			throw new Error(`configured directory is owned by uid ${stats.uid}, expected ${currentUid}`);
		}

		if (platform() !== "win32" && (stats.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== 0) {
			throw new Error("configured directory permissions are not private");
		}

		await access(directory, fsConstants.W_OK | fsConstants.X_OK);
		return null;
	} catch (error) {
		// biome-ignore lint/performance/noDelete: an invalid override must not reach the Claude subprocess.
		delete env.CLAUDE_CODE_TMPDIR;
		return error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Reassemble arbitrary stderr chunks into bounded lines before inspection.
 * Callers must redact each emitted line before writing it to application logs.
 */
export function createLineBufferedDiagnosticSink(onLine: (line: string) => void): {
	write(data: Buffer | string): void;
	end(): void;
} {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let discardingOversizedLine = false;
	let ended = false;

	const emitCompletedLine = (line: string) => {
		if (discardingOversizedLine || line.length > MAX_DIAGNOSTIC_LINE_LENGTH) {
			onLine(OVERSIZED_DIAGNOSTIC_PLACEHOLDER);
		} else {
			onLine(line);
		}
		discardingOversizedLine = false;
	};

	const consume = (text: string) => {
		pending += text;
		let newlineIndex = pending.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = pending.slice(0, newlineIndex + 1);
			pending = pending.slice(newlineIndex + 1);
			emitCompletedLine(line);
			newlineIndex = pending.indexOf("\n");
		}

		if (pending.length > MAX_DIAGNOSTIC_LINE_LENGTH) {
			pending = "";
			discardingOversizedLine = true;
		}
	};

	return {
		write(data) {
			if (ended) return;
			consume(typeof data === "string" ? data : decoder.write(data));
		},
		end() {
			if (ended) return;
			ended = true;
			consume(decoder.end());
			if (discardingOversizedLine) {
				onLine(OVERSIZED_DIAGNOSTIC_PLACEHOLDER);
			} else if (pending) {
				onLine(pending);
			}
			pending = "";
			discardingOversizedLine = false;
		},
	};
}

/** Redact credentials before copying runtime diagnostics to application logs. */
export function redactClaudeRuntimeDiagnostic(
	text: string,
	secrets: ReadonlyArray<string | undefined> = [],
): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	}

	return redacted
		.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
		.replace(
			/((?:ANTHROPIC_(?:AUTH_TOKEN|API_KEY)|api[_-]?key|auth[_-]?token|authorization|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}\]]+/gi,
			"$1[REDACTED]",
		);
}

/**
 * Extract only trusted SDK-generated error records from a debug-log tail.
 * Debug logs may contain prompts and responses, so arbitrary lines must never
 * be copied into the application log.
 */
export function extractSafeClaudeSdkErrorLines(debugTail: string): string {
	const errorLinePattern =
		/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\[(?:ERROR|WARN)\]\s+(?:API error \(attempt|Error in API request|Error processing --settings|Error processing settings|Error processing --setting-sources|Invalid --setting-sources flag)[^\r\n]*$/gm;

	return debugTail.match(errorLinePattern)?.join("\n") ?? "";
}
