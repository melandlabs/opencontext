/**
 * `runWithAutoCompact` — transparent context-overflow recovery wrapper
 * around `IAgent.run`.
 *
 * Two trigger paths, mirroring the industry-standard split (Codex CLI,
 * OpenClaw, Cline, Roo, OpenHands all use the same shape):
 *
 *   1. PROACTIVE — when `compactThresholdTokens` is set and the estimated
 *      tokens of `history` exceed it, a compaction pass runs BEFORE the
 *      first attempt, so the model never sees an overflow in the common
 *      case.
 *   2. REACTIVE — the wrapper intercepts the agent's stream, watches for a
 *      `kind: "context_overflow"` error message, and recovers on detection.
 *
 * A compaction pass:
 *   - Calls `agent.compactContext(...)` over the prior history the caller
 *     passed in (`history`) — skipped when `history` is empty.
 *   - Re-issues the run with the summary embedded in the prompt as a
 *     `[carry-forward]` block PLUS the most recent messages kept verbatim
 *     (a bounded tail, `keepRecentTokens`) — recent turns carry the
 *     highest task-relevant detail, so summarizing everything loses too
 *     much (the keep-recent-tail pattern from OpenClaw / Cline / Codex).
 *   - Invokes `onCompactionBaseline` with a structured replacement history
 *     (`[system: carry-forward summary, ...verbatim tail]`) so stateful
 *     hosts can adopt the post-compaction baseline and stop re-sending the
 *     original oversized history on every turn.
 *   - Yields an informational `type: "retry"` message before the retry
 *     stream so the caller can show a "compacted N → M tokens" toast and
 *     DROP the aborted attempt's partial output (the retry re-emits a
 *     fresh stream from scratch).
 *
 * Failure semantics:
 *   - Non-overflow errors pass through unchanged.
 *   - If the compaction LLM call fails, a deterministic fallback drops the
 *     oldest half of the history once and retries with a truncation notice
 *     (Cline's rule: recovery must not depend on another successful LLM
 *     request). If that retry also overflows, the original overflow error
 *     is surfaced verbatim (annotated with the compaction failure).
 *   - When the attempt budget runs out, the last overflow error is
 *     surfaced verbatim (annotated with the exhausted budget).
 *
 * Retry budget is bounded by `maxAttempts` (default 2 — one retry is enough
 * for the common case; the budget is a backstop against pathological
 * configurations where every compaction is still too large).
 *
 * Most callers don't need this wrapper directly anymore — `BaseAgent.run`
 * already applies the same loop when the agent has a
 * `providerConfig.compactor`, wiring `compactThresholdTokens` /
 * `compactKeepRecentTokens` / `compactMaxSummaryTokens` from the same
 * config bag. The exported wrapper is preserved for tests and advanced
 * callers that want to drive the recovery loop from an external `IAgent`
 * stub.
 */

import { estimateTokens } from "./billing/tokens";
import type {
	AgentMessage,
	AgentOptions,
	CompactContextInput,
	CompactContextResult,
	ConversationMessage,
	IAgent,
} from "./types";

/** Default verbatim-tail budget for the retry prompt / baseline. */
const DEFAULT_KEEP_RECENT_TOKENS = 4000;

export interface RunWithAutoCompactOptions {
	/** Original prompt to forward to `agent.run`. */
	prompt: string;
	/**
	 * Conversation history to summarize if the agent signals context overflow
	 * (or proactively, when `compactThresholdTokens` is exceeded). Empty /
	 * undefined means "this is a one-shot prompt with no prior context": no
	 * compaction pass runs, and a reactive retry re-issues the original
	 * prompt unchanged (if it overflows again the budget-exhausted branch
	 * surfaces the overflow error).
	 */
	history?: ConversationMessage[];
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
	 * raw `CompactContextResult` and the 1-based attempt that triggered it
	 * (0 for a proactive pre-attempt compaction). Useful for telemetry.
	 */
	onCompacted?: (result: CompactContextResult, attempt: number) => void;
	/**
	 * Proactive trigger: when set and the estimated tokens of `history`
	 * exceed this value, compaction runs BEFORE the first attempt. Undefined
	 * (default) = reactive-only (compact after an overflow error).
	 */
	compactThresholdTokens?: number;
	/**
	 * Verbatim-tail budget: the most recent messages whose estimated tokens
	 * fit in this budget are kept verbatim in the retry prompt and in the
	 * `onCompactionBaseline` history. @default 4000
	 */
	keepRecentTokens?: number;
	/**
	 * Hard cap on the generated summary length, forwarded to
	 * `agent.compactContext` as `maxSummaryTokens`.
	 */
	maxSummaryTokens?: number;
	/**
	 * Fired after every successful compaction pass with a structured
	 * replacement history the host can adopt: a leading system entry
	 * carrying the carry-forward summary, followed by the verbatim recent
	 * tail. Stateful hosts should replace their conversation with this
	 * baseline — otherwise every subsequent turn re-sends the original
	 * oversized history and compaction runs again from scratch.
	 */
	onCompactionBaseline?: (baseline: ConversationMessage[], result: CompactContextResult) => void;
	/**
	 * HTTP compaction endpoint override forwarded to
	 * `agent.compactContext` for this call. Per-call override; agent-level
	 * fallback lives in `providerConfig.compactionEndpoint.baseUrl`. Ignored
	 * when the agent has a `providerConfig.compactor` configured.
	 */
	compactionEndpoint?: string;
	/**
	 * Bearer token forwarded to `agent.compactContext` for this call as
	 * `Authorization: Bearer <token>`. Per-call override; agent-level
	 * fallback lives in `providerConfig.compactionUserToken`. May be
	 * undefined — when undefined, the `Authorization` header is omitted
	 * and the summarizer is unauthenticated.
	 */
	compactionUserToken?: string;
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
	const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;

	let attempts = 0;
	let lastCompaction: CompactContextResult | undefined;
	let usedTruncationFallback = false;

	const runCompaction = async (): Promise<
		{ ok: true; result: CompactContextResult } | { ok: false; error: unknown }
	> => {
		try {
			const result = await agent.compactContext({
				messages: history,
				level,
				maxSummaryTokens: options.maxSummaryTokens,
				// HTTP-first path: forward the resolved endpoint + user token.
				// The agent's `compactContext` decides whether to use these
				// (only when no `providerConfig.compactor` is set).
				compactionEndpoint: options.compactionEndpoint,
				userToken: options.compactionUserToken,
			});
			return { ok: true, result };
		} catch (error) {
			return { ok: false, error };
		}
	};

	const emitBaseline = (): void => {
		if (!lastCompaction || !options.onCompactionBaseline) {
			return;
		}
		const tail = takeRecentTail(history, keepRecentTokens);
		options.onCompactionBaseline(
			[
				{
					role: "system",
					content: `[Carry-forward summary from earlier ${history.length} message(s)]\n${lastCompaction.summary}`,
				},
				...tail,
			],
			lastCompaction,
		);
	};

	// Proactive trigger: compact before the first attempt when the estimated
	// history size already exceeds the configured threshold.
	const proactive =
		options.compactThresholdTokens != null &&
		history.length > 0 &&
		estimateConversationTokens(history) > options.compactThresholdTokens;

	while (attempts < maxAttempts) {
		attempts += 1;

		if (attempts === 1 && proactive && !lastCompaction) {
			const compaction = await runCompaction();
			if (compaction.ok) {
				lastCompaction = compaction.result;
				options.onCompacted?.(lastCompaction, 0);
				emitBaseline();
				yield buildRetryNotice(
					0,
					maxAttempts,
					`proactively compacted ${history.length} prior message(s) → ${lastCompaction.summaryTokens} tokens (threshold ${options.compactThresholdTokens})`,
				);
			} else {
				// Proactive compaction is best-effort: a failure here is not
				// fatal (nothing has overflowed yet), so proceed un-compacted.
				const reason =
					compaction.error instanceof Error ? compaction.error.message : String(compaction.error);
				yield buildRetryNotice(
					0,
					maxAttempts,
					`proactive compaction failed (${reason}); proceeding un-compacted`,
				);
			}
		}

		const effectivePrompt = !lastCompaction
			? options.prompt
			: buildRetryPrompt(options.prompt, lastCompaction, takeRecentTail(history, keepRecentTokens));

		let overflowError: AgentMessage | undefined;
		for await (const message of runOnce(effectivePrompt, options.agentOptions)) {
			if (message.type === "error" && message.kind?.kind === "context_overflow") {
				overflowError = message;
				break;
			}
			yield message;
		}

		if (!overflowError) {
			return;
		}

		// Out of budget — surface the final overflow error verbatim, annotated
		// with the exhausted budget.
		if (attempts >= maxAttempts) {
			yield withNote(overflowError, `auto-compact budget exhausted after ${attempts} attempt(s)`);
			return;
		}

		// No prior history: nothing to summarize, so retry the original
		// prompt unchanged (`lastCompaction` stays undefined, so the next
		// iteration re-issues `options.prompt`).
		if (history.length === 0) {
			yield buildRetryNotice(
				attempts,
				maxAttempts,
				"no prior history to compact; retrying the original prompt",
			);
			continue;
		}

		const compaction = await runCompaction();
		if (compaction.ok) {
			lastCompaction = compaction.result;
			options.onCompacted?.(lastCompaction, attempts);
			emitBaseline();
			yield buildRetryNotice(
				attempts,
				maxAttempts,
				`compacted ${history.length} prior message(s) → ${lastCompaction.summaryTokens} tokens`,
			);
			continue;
		}

		// Compaction failed. Deterministic fallback (Cline-style): drop the
		// oldest half ONCE and retry with a truncation notice instead of an
		// LLM summary — recovery must not depend on another successful LLM
		// request. If the fallback retry also overflows, the loop exhausts
		// its budget and surfaces the original overflow error below.
		if (!usedTruncationFallback && history.length > 1) {
			usedTruncationFallback = true;
			const reason = compaction.error instanceof Error ? compaction.error.message : String(compaction.error);
			const droppedCount = Math.floor(history.length / 2);
			lastCompaction = {
				summary: `Older conversation history was truncated automatically after summarization failed (${reason}). The oldest ${droppedCount} of ${history.length} messages were dropped; the most recent messages are preserved verbatim.`,
				messageCount: droppedCount,
				level,
				originalTokens: 0,
				summaryTokens: 0,
			};
			emitBaseline();
			yield buildRetryNotice(
				attempts,
				maxAttempts,
				`summarizer failed (${reason}); dropped the oldest ${droppedCount} message(s) and retrying deterministically`,
			);
			continue;
		}

		const reason = compaction.error instanceof Error ? compaction.error.message : String(compaction.error);
		yield withNote(overflowError, `auto-compaction failed: ${reason}`);
		return;
	}
}

/**
 * Run `agent.run(prompt)` with automatic context-overflow recovery.
 *
 * The returned async generator yields:
 *   - Every message the underlying agent emitted (text / tool_use /
 *     result / session / etc).
 *   - On compaction (proactive or reactive), a synthetic `type: "retry"`
 *     informational message (`[auto-compact] ... — retrying ...`) BEFORE
 *     the retry stream starts. The agent's own overflow error message is
 *     suppressed (we already acted on it). Hosts should treat this retry
 *     notice like any other `retry` message: drop the aborted attempt's
 *     partial output, because the retry stream re-emits from scratch.
 *   - A final marker is not emitted — the underlying agent's `result` /
 *     `error` message closes the stream.
 *
 * Telemetry (number of attempts, last compaction result, suggested
 * baseline history) is delivered via the `onCompacted` /
 * `onCompactionBaseline` callbacks rather than generator return values, so
 * the shape stays a plain `AsyncGenerator<AgentMessage>` and is drop-in
 * compatible with `for await (const msg of agent.run(...))`.
 */
export async function* runWithAutoCompact(
	agent: IAgent,
	options: RunWithAutoCompactOptions,
): AsyncGenerator<AgentMessage> {
	yield* runWithAutoCompactCore(agent, (p, o) => agent.run(p, o), options);
}

/**
 * Informational notice emitted around a compaction / retry. Uses the
 * shared `retry` message type (`attempt` = the 1-based upcoming attempt,
 * `maxAttempts` = the total budget) so hosts render it with the same
 * localized retry UI they already use for transport-level retries; the
 * `[auto-compact]` message prefix carries the compaction specifics.
 */
function buildRetryNotice(attemptsUsed: number, maxAttempts: number, detail: string): AgentMessage {
	return {
		type: "retry",
		attempt: attemptsUsed + 1,
		maxAttempts,
		message: `[auto-compact] ${detail} — retrying (attempt ${attemptsUsed + 1}/${maxAttempts}).`,
	};
}

/** Return a copy of the error message with `note` appended to its text. */
function withNote(error: AgentMessage, note: string): AgentMessage {
	return {
		...error,
		message: `${error.message ?? "Context overflow."} (${note})`,
	};
}

/**
 * Build a retry prompt that folds the compaction summary and the verbatim
 * recent tail in front of the original prompt. The summary rides in a
 * `[carry-forward]` block so the model treats it as explicit carry-forward
 * context; the tail is role-labelled so the recent turns read as
 * conversation, not as instructions.
 */
function buildRetryPrompt(
	originalPrompt: string,
	compaction: CompactContextResult,
	tail: ConversationMessage[],
): string {
	const parts = [
		`[carry-forward summary from earlier ${compaction.messageCount} message(s)]`,
		compaction.summary,
	];
	if (tail.length > 0) {
		parts.push("", "[recent messages kept verbatim]", ...tail.map((m) => `${m.role}: ${m.content}`));
	}
	parts.push("", "---", "", originalPrompt);
	return parts.join("\n");
}

/**
 * Select the newest prefix of `messages` whose estimated tokens fit the
 * budget, walking backwards so the most recent turns always survive.
 */
function takeRecentTail(messages: ConversationMessage[], budgetTokens: number): ConversationMessage[] {
	const selected: ConversationMessage[] = [];
	let used = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const tokens = estimateTokens(messages[i].content);
		if (selected.length > 0 && used + tokens > budgetTokens) {
			break;
		}
		selected.unshift(messages[i]);
		used += tokens;
	}
	return selected;
}

function estimateConversationTokens(messages: ConversationMessage[]): number {
	return messages.reduce<number>((sum, msg) => sum + estimateTokens(msg.content), 0);
}
