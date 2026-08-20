import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SELECTABLE_AGENT_RUNTIMES, type SelectableAgentRuntime } from "./runtime-contract";

export {
	SELECTABLE_AGENT_RUNTIMES,
	type SelectableAgentRuntime,
} from "./runtime-contract";

const RUNTIME_PREFERENCE_FILE_NAME = "agent-runtime.json";

/**
 * App-data directory where the host's desktop build stores the selected
 * agent runtime. Desktop builds (Tauri, Electron) typically override
 * `getAppDir()`; in library / server contexts we fall back to the
 * `OPENCONTEXT_APP_DIR` environment variable or the bare name.
 */
export function getAppDir(): string {
	return process.env.OPENCONTEXT_APP_DIR?.trim() || "opencontext";
}

export function getAgentRuntimePreferencePath(): string {
	return join(getAppDir(), RUNTIME_PREFERENCE_FILE_NAME);
}

export function readAgentRuntimePreference(
	filePath = getAgentRuntimePreferencePath(),
): SelectableAgentRuntime | undefined {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!isRuntimePreference(parsed)) {
			console.warn(`[agent-runtime] Ignoring invalid runtime preference at ${filePath}`);
			return undefined;
		}
		return parsed.provider;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[agent-runtime] Unable to read runtime preference at ${filePath}`, error);
		}
		return undefined;
	}
}

export function writeAgentRuntimePreference(
	provider: SelectableAgentRuntime,
	filePath = getAgentRuntimePreferencePath(),
): void {
	if (!SELECTABLE_AGENT_RUNTIMES.includes(provider)) {
		throw new TypeError(`Unsupported agent runtime: ${String(provider)}`);
	}

	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

	try {
		writeFileSync(temporaryPath, `${JSON.stringify({ provider }, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, filePath);
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write/rename error if best-effort cleanup fails.
		}
		throw error;
	}
}

export function clearAgentRuntimePreference(filePath = getAgentRuntimePreferencePath()): void {
	rmSync(filePath, { force: true });
}

function isRuntimePreference(value: unknown): value is { provider: SelectableAgentRuntime } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const provider = (value as { provider?: unknown }).provider;
	return (
		typeof provider === "string" && SELECTABLE_AGENT_RUNTIMES.includes(provider as SelectableAgentRuntime)
	);
}
