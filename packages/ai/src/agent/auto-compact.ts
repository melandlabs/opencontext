/**
 * `runWithAutoCompact` — transparent overflow-recovery wrapper around
 * `IAgent.run`.
 *
 * The wrapper intercepts the agent's stream, watches for a
 * `kind: "context_overflow"` error message, and on detection:
 *
 *   1. Calls `agent.compactContext(...)` over the prior history the caller
 *      passed in (`history`).
 *   2. Re-issues `agent.run(prompt)` with a re-prefixed system prompt that
 *      embeds the compaction summary, so the model sees the carry-forward
 *      context on the retry.
 *   3. Yields an informational `type: "scheduleNotice"` / `message`-tagged
 *      synthetic message before the retry stream so the caller can show a
 *      "compacted N → M tokens" toast in the UI.
 *
 * Retry budget is bounded by `maxAttempts` (default 2 — one retry is enough
 * for the common case; the budget is a backstop against pathological
 * configurations where every compaction is still too large).
 *
 * Non-overflow errors are passed through unchanged.
 *
 * Most callers don't need this wrapper directly anymore — `BaseAgent.run`
 * already applies the same overflow-recovery loop when the agent has a
 * `providerConfig.compactor`. The exported wrapper is preserved for
 * tests and advanced callers that want to drive the recovery loop from an
 * external `IAgent` stub.
 */

import type {
	AgentHistoryMessage,
	AgentMessage,
	AgentOptions,
	CompactContextInput,
	CompactContextResult,
	IAgent,
} from "./types";

/**
 * Back-compat alias for {@link AgentHistoryMessage}. New code should prefer
 * importing `AgentHistoryMessage` directly from `@melandlabs/ai`.
 */
export type AutoCompactHistoryMessage = AgentHistoryMessage;

export interface RunWithAutoCompactOptions {
	/** Original prompt to forward to `agent.run`. */
	prompt: string;
	/**
	 * Conversation history to summarize if the agent signals context overflow.
	 * Empty / undefined means "this is a one-shot prompt with no prior context";
	 * the wrapper will still retry once with no extra prefix when overflow
	 * occurs, but the second attempt has no summary to fold in.
	 */
	history?: AutoCompactHistoryMessage[];
	/** Underlying agent options (abort controller, custom prompt, …). */
	agentOptions?: AgentOptions;
	/**
	 * Compaction level used for the overflow-recovery summary.
	 * @default "hard"
	 */
	level?: CompactContextInput["level"];
	/**
	 * Maximum number of attempts including the first try. Must be `>= 1`.
	 * @default 2
	 */
	maxAttempts?: number;
	/**
	 * Optional callback fired after a successful compaction pass, with the
	 * raw `CompactContextResult`. Useful for telemetry / logging.
	 */
	onCompacted?: (result: CompactContextResult, attempt: number) => void;
}

/**
 * Type of the per-attempt `run` primitive that the auto-compact loop
 * invokes. Used by {@link runWithAutoCompactCore} so `BaseAgent.run` can
 * pass `(p, o) => this.runCore(p, o)` and avoid re-entering the
 * transparent `run` wrapper. External callers should keep using
 * {@link runWithAutoCompact} which takes the agent itself.
 */
export type AutoCompactRunOnce = (prompt: string, options?: AgentOptions) => AsyncGenerator<AgentMessage>;

/**
 * Internal core of the auto-compact loop. Takes the retry primitive as a
 * function so `BaseAgent.run` can pass `(p, o) => this.runCore(p, o)` and
 * never re-enter the wrapper. Not exported from the package barrel —
 * {@link runWithAutoCompact} is the public surface for tests / external
 * `IAgent` stubs.
 */
export async function* runWithAutoCompactCore(
	agent: IAgent,
	runOnce: AutoCompactRunOnce,
	options: RunWithAutoCompactOptions,
): AsyncGenerator<AgentMessage> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
	const level = options.level ?? "hard";
	const history = options.history ?? [];

	let attempts = 0;
	let lastCompaction: CompactContextResult | undefined;

	while (attempts < maxAttempts) {
		attempts += 1;

		const effectivePrompt =
			attempts === 1 || !lastCompaction ? options.prompt : buildRetryPrompt(options.prompt, lastCompaction);

		let overflowed = false;
		for await (const message of runOnce(effectivePrompt, options.agentOptions)) {
			if (message.type === "error" && message.kind?.kind === "context_overflow") {
				overflowed = true;
				break;
			}
			yield message;
		}

		if (!overflowed) {
			return;
		}

		// Out of budget — surface the final overflow error verbatim.
		if (attempts >= maxAttempts) {
			yield {
				type: "error",
				message: `Context overflow after ${attempts} attempts (budget exhausted).`,
				kind: { kind: "context_overflow", message: "Context overflow budget exhausted." },
			};
			return;
		}

		// Compact and yield a synthetic notice before the retry stream.
		lastCompaction = await agent.compactContext({
			messages: history,
			level,
		});
		options.onCompacted?.(lastCompaction, attempts);

		yield {
			type: "scheduleNotice",
			scheduleNotice: "below_minimum",
			message: `[auto-compact] Compacted ${history.length} prior message(s) → ${lastCompaction.summaryTokens} tokens (attempt ${attempts}/${maxAttempts}).`,
		};
	}
}

/**
 * Run `agent.run(prompt)` with automatic context-overflow recovery.
 *
 * The returned async generator yields:
 *   - Every message the underlying agent emitted (text / tool_use /
 *     result / session / etc).
 *   - On overflow, a synthetic informational message tagged via `message`
 *     (`[auto-compact] Compacted N → M tokens; retrying...`) BEFORE the
 *     retry stream starts. The agent's own overflow error message is
 *     suppressed (we already acted on it).
 *   - A final marker is not emitted — the underlying agent's `result` /
 *     `error` message closes the stream.
 *
 * Telemetry (number of attempts, last compaction result) is delivered via
 * the `onCompacted` callback rather than a generator return value, so the
 * shape stays a plain `AsyncGenerator<AgentMessage>` and is drop-in
 * compatible with `for await (const msg of agent.run(...))`.
 */
export async function* runWithAutoCompact(
	agent: IAgent,
	options: RunWithAutoCompactOptions,
): AsyncGenerator<AgentMessage> {
	yield* runWithAutoCompactCore(agent, (p, o) => agent.run(p, o), options);
}

/**
 * Build a retry prompt that folds the compaction summary in front of the
 * original prompt. Wrapping the summary in a clear `[carry-forward]` block
 * keeps the model's attention on it as an explicit carry-forward, not as a
 * user message.
 */
function buildRetryPrompt(originalPrompt: string, compaction: CompactContextResult): string {
	return [
		`[carry-forward summary from earlier ${compaction.messageCount} message(s)]`,
		compaction.summary,
		"",
		"---",
		"",
		originalPrompt,
	].join("\n");
}
