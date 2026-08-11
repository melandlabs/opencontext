/**
 * Codex timeout-interruption marker — pure utility for encoding / decoding a
 * sentinel payload that the chat UI and runtime layer both need to read.
 *
 * Kept server-safe (no Node-only deps) so client components can parse the
 * marker without pulling in the Codex CLI subprocess layer.
 */

export const CODEX_INTERRUPTED_MARKER = "__CODEX_INTERRUPTED__";

export interface CodexInterruptedContext {
	timeoutMs: number;
	workspacePath: string;
	completedArtifacts: string[];
}

/**
 * Format a Codex error message carrying the marker + structured payload
 * the chat UI uses to render a Continue action that reuses the existing
 * workspace.
 */
export function formatCodexInterruptedError(context: CodexInterruptedContext) {
	const payload = JSON.stringify({
		marker: CODEX_INTERRUPTED_MARKER,
		reason: "timeout",
		timeoutMs: context.timeoutMs,
		workspacePath: context.workspacePath,
		completedArtifacts: context.completedArtifacts,
		canResume: true,
	});
	return `${CODEX_INTERRUPTED_MARKER} ${payload}`;
}

/**
 * Parse a Codex interrupted marker message back into its structured payload.
 * Returns `null` for any other error string so callers can safely chain
 * `if (parse(...))` checks before handling the interruption.
 */
export function parseCodexInterruptedError(
	raw: string,
): (CodexInterruptedContext & { canResume: boolean }) | null {
	if (!raw || !raw.startsWith(CODEX_INTERRUPTED_MARKER)) {
		return null;
	}

	const tail = raw.slice(CODEX_INTERRUPTED_MARKER.length).trim();
	try {
		const parsed = JSON.parse(tail) as {
			marker?: string;
			reason?: string;
			timeoutMs?: number;
			workspacePath?: string;
			completedArtifacts?: string[];
			canResume?: boolean;
		};

		if (parsed.marker !== CODEX_INTERRUPTED_MARKER) {
			return null;
		}

		return {
			timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 0,
			workspacePath: typeof parsed.workspacePath === "string" ? parsed.workspacePath : "",
			completedArtifacts: Array.isArray(parsed.completedArtifacts)
				? parsed.completedArtifacts.filter((entry): entry is string => typeof entry === "string")
				: [],
			canResume: parsed.canResume !== false,
		};
	} catch {
		return null;
	}
}
