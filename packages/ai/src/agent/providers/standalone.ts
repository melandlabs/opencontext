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

import { generateText } from "ai";

import { createDynamicModel } from "../model/providers";
import {
	BaseAgent,
	defineAgentPlugin,
	STANDALONE_METADATA,
	type AgentConfig,
	type AgentMessage,
	type AgentOptions,
	type AgentProvider,
	type ExecuteOptions,
	type PlanOptions,
} from "../index";

/** Provider type discriminator. Matches `STANDALONE_METADATA.type`. */
const STANDALONE_PROVIDER = "standalone" as const satisfies AgentProvider;

/**
 * Resolve `isNativeMode` from the agent config.
 *
 * `BaseAgent` does not carry an explicit native flag, so we read it from
 * `providerConfig.isNativeMode` (boolean) and default to `false`. The
 * flag is the same one the rest of the model layer uses to pick the
 * correct fetch / auth path.
 */
function resolveIsNativeMode(config: AgentConfig): boolean {
	const raw = config.providerConfig?.isNativeMode;
	return typeof raw === "boolean" ? raw : false;
}

export class StandaloneAgent extends BaseAgent {
	readonly provider: AgentProvider = STANDALONE_PROVIDER;

	/**
	 * Standalone never plans — it just answers. We surface the upstream
	 * prompt straight to the model and return its reply as a single
	 * `text` message.
	 */
	async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage> {
		const session = this.createSession("executing");
		const sessionId = session.id;

		yield { type: "session", sessionId };

		if (session.isAborted) {
			yield { type: "error", sessionId, message: "Session aborted before run started" };
			return;
		}

		const start = Date.now();
		const model = createDynamicModel(resolveIsNativeMode(this.config), this.config.model);

		// Honor an explicit abort controller on the options if the host
		// passes one; otherwise fall back to the session's controller.
		const abortSignal = options?.abortController?.signal ?? session.abortController.signal;

		try {
			const result = await generateText({
				model,
				prompt,
				// aiSoulPrompt is the user-defined custom instruction — feed it
				// through as the system prompt so the demo flow stays useful.
				system: options?.aiSoulPrompt ?? undefined,
				abortSignal,
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
			yield { type: "error", sessionId, message };
		}
	}

	/**
	 * `plan` is a no-op for a single-shot agent — we surface the prompt as
	 * a direct answer rather than fabricating a TaskPlan. Implementations
	 * that need a real plan should use a different provider.
	 */
	async *plan(prompt: string, _options?: PlanOptions): AsyncGenerator<AgentMessage> {
		yield* this.run(prompt, _options);
	}

	/**
	 * `execute` mirrors `run`: there is no approved plan to walk through,
	 * so we just call the model with the original prompt.
	 */
	async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
		yield* this.run(options.originalPrompt, options);
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
