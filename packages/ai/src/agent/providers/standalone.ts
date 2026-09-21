/**
 * Standalone Agent — built-in `IAgent` provider that does exactly one LLM
 * call. No tools, no planning, no sandbox. The smallest possible agent, used
 * by the SDK examples and for tests that just need a real chat completion
 * wired through the registry / runtime.
 *
 * Consumers register the plugin once (e.g. from a host app's bootstrap):
 *
 * ```ts
 * import { registerAgentPlugin, standaloneAgentPlugin } from "@melandlabs/ai";
 *
 * registerAgentPlugin(standaloneAgentPlugin);
 *
 * const agent = await getAgentInstance("standalone", {
 *   provider: "standalone",
 *   model: "openai/gpt-4o-mini",
 * });
 *
 * for await (const msg of agent.run("Summarise X in one sentence.")) {
 *   if (msg.type === "text") console.log(msg.content);
 * }
 * ```
 */

import type { ModelMessage } from "ai";
import { generateText } from "ai";

import { isContextOverflowError } from "../compaction/overflow";
import {
	type AgentConfig,
	type AgentMessage,
	type AgentOptions,
	type AgentProvider,
	BaseAgent,
	type ExecuteOptions,
	type PlanOptions,
	STANDALONE_METADATA,
	defineAgentPlugin,
} from "../index";

import { createStandaloneModel } from "./_internal/standalone-model";

/**
 * Heuristic for "this looks like the model refused because the prompt is
 * too large" — re-exported from the compaction module (canonical
 * definition lives there so `runCompactor` can share it).
 *
 * Exported for unit tests + the `runWithAutoCompact` wrapper (which is the
 * canonical consumer of this classification).
 */
export { isContextOverflowError };

/** Provider type discriminator. Matches `STANDALONE_METADATA.type`. */
const STANDALONE_PROVIDER = "standalone" as const satisfies AgentProvider;

/**
 * Resolve the explicit wire-protocol type from `providerConfig.providerType`.
 *
 * Mirrors the `providerType` shape returned by `getValidatedEnv` in
 * `packages/ai/src/agent/model/providers.ts` so callers can switch the
 * standalone agent between Anthropic-compatible and OpenAI-compatible
 * endpoints without forking it. Defaults to `"anthropic_compatible"` to
 * preserve backward compatibility with the original hard-coded
 * `createAnthropic` behaviour.
 */
function resolveStandaloneProviderType(
	config: AgentConfig,
): "anthropic_compatible" | "openai_compatible" | undefined {
	const raw = config.providerConfig?.providerType;
	if (raw === "openai_compatible" || raw === "anthropic_compatible") return raw;
	return undefined;
}

export class StandaloneAgent extends BaseAgent {
	readonly provider: AgentProvider = STANDALONE_PROVIDER;

	/**
	 * Standalone never plans — it just answers. We surface the upstream
	 * prompt straight to the model and return its reply as a single
	 * `text` message.
	 */
	async *runCore(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage> {
		const session = this.createSession("executing");
		const sessionId = session.id;

		yield { type: "session", sessionId };

		if (session.isAborted) {
			yield { type: "error", sessionId, message: "Session aborted before run started" };
			return;
		}

		const start = Date.now();
		// Honor an explicit abort controller on the options if the host
		// passes one; otherwise fall back to the session's controller.
		const abortSignal = options?.abortController?.signal ?? session.abortController.signal;

		// `systemPrompt` (explicit run override) wins over `aiSoulPrompt`
		// (user-defined custom instruction), matching the precedence the
		// Claude provider applies to these two fields.
		const system = options?.systemPrompt ?? options?.aiSoulPrompt ?? undefined;

		// TODO: map `ConversationMessage.imagePaths` to AI SDK image parts so
		// multimodal single-turn calls (e.g. screenshot analysis) work
		// through the standalone provider. Out of scope for this change —
		// the alloomi-side mirror (`PlatformStandaloneAgent`) currently
		// bypasses StandaloneAgent for multimodal calls via `userContent`.
		const messages: ModelMessage[] = [
			...(options?.conversation ?? []).map((m) => ({
				role: m.role,
				content: m.content,
			})),
			{ role: "user", content: prompt },
		];

		try {
			// `createStandaloneModel` throws when `apiKey` / `baseUrl` are
			// missing — sitting it inside the try block lets the existing
			// error path below surface the message to the caller as an
			// `upstream_error` `AgentMessage`.
			const model = createStandaloneModel({
				modelName: this.config.model,
				apiKey: this.config.apiKey,
				baseUrl: this.config.baseUrl,
				providerType: resolveStandaloneProviderType(this.config),
			});

			const result = await generateText({
				model,
				messages,
				system,
				abortSignal,
				...(options?.extraHeaders ? { headers: options.extraHeaders } : {}),
			});

			if (session.isAborted) {
				return;
			}

			yield { type: "text", sessionId, content: result.text };

			yield {
				type: "result",
				sessionId,
				content: result.text,
				cost: result.usage?.totalTokens ?? 0,
				duration: Date.now() - start,
				usage: result.usage
					? {
							inputTokens: result.usage.inputTokens ?? 0,
							outputTokens: result.usage.outputTokens ?? 0,
						}
					: undefined,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Classify context-window overflow errors so the
			// `runWithAutoCompact` wrapper can detect them and re-issue the
			// request after a compaction pass. We match the AI SDK's error
			// shape (the upstream provider's status code + "context" /
			// "too long" / "tokens" hints) rather than trusting provider-
			// specific strings.
			const kind = isContextOverflowError(error)
				? ({ kind: "context_overflow", message } as const)
				: ({ kind: "upstream_error", message } as const);
			yield { type: "error", sessionId, message, kind };
		}
	}

	/**
	 * `plan` is a no-op for a single-shot agent — we surface the prompt as
	 * a direct answer rather than fabricating a TaskPlan. Implementations
	 * that need a real plan should use a different provider.
	 */
	async *plan(prompt: string, _options?: PlanOptions): AsyncGenerator<AgentMessage> {
		yield* this.runCore(prompt, _options);
	}

	/**
	 * `execute` mirrors `run`: there is no approved plan to walk through,
	 * so we just call the model with the original prompt.
	 */
	async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
		yield* this.runCore(options.originalPrompt, options);
	}

	/**
	 * Standalone has no plan store — surface this explicitly so callers
	 * that switch providers mid-flow get a clear signal.
	 */
	override getPlan(_planId: string): undefined {
		return undefined;
	}

	override deletePlan(_planId: string): void {
		// no-op: standalone never stores plans
	}
}

/**
 * Plugin wrapper for `StandaloneAgent`. Register once at process boot:
 *
 *   `registerAgentPlugin(standaloneAgentPlugin)`
 *
 * Mirrors the convention used by the Claude / Codex / DeepAgents
 * `*_METADATA` constants.
 */
export const standaloneAgentPlugin = defineAgentPlugin({
	metadata: STANDALONE_METADATA,
	factory: (config: AgentConfig) => new StandaloneAgent(config),
});

/**
 * Convenience constructor that mirrors `createClaudeAgent` /
 * `createCodexAgent`. Lets callers wire up a `StandaloneAgent` instance
 * directly without going through the plugin registry — useful for tests
 * and for one-off callers that want to pin explicit credentials on a
 * single agent instead of registering a provider.
 */
export function createStandaloneAgent(config: AgentConfig): StandaloneAgent {
	return new StandaloneAgent(config);
}
