/**
 * @melandlabs/opencontext — context-compaction factory.
 *
 * Mirrors `memory-reasoning.ts`: takes a thin LLM-provider wiring layer
 * (model + base URL + api key) and hands it to the provider-agnostic
 * compactor primitive in `@melandlabs/ai`. Never hardcodes an HTTP endpoint
 * or model id; never calls the legacy `/api/ai/v1/chat/completions` route.
 *
 * This is the entry point hosts use to populate `AgentConfig.providerConfig.compactor`
 * so they can call `IAgent.compactContext(...)` from anywhere in the agent loop.
 */

import {
	type CompactContextInput,
	type CompactContextResult,
	type Compactor,
	type RunCompactorOptions,
	runCompactor,
} from "@melandlabs/ai";
import type { LanguageModel } from "ai";

import { type LLMProviderType, createLanguageModel } from "./llm-factory";

export interface CompactorModelOptions {
	/** OpenAI-compatible or Anthropic-compatible API key. Falls back to OPENCONTEXT_LLM_API_KEY. */
	apiKey?: string;
	/** OpenAI-compatible or Anthropic-compatible base URL. Falls back to OPENCONTEXT_LLM_BASE_URL. */
	baseUrl?: string;
	/** Model identifier. Falls back to OPENCONTEXT_LLM_MODEL. */
	model?: string;
	/**
	 * A pre-built language model. When provided, apiKey/baseUrl/model are
	 * ignored.
	 */
	languageModel?: LanguageModel;
	/**
	 * Force a specific provider. When omitted, the factory detects from
	 * baseUrl (substring `"anthropic"`, case-insensitive). Default is
	 * `"openai_compatible"`.
	 */
	providerType?: LLMProviderType;
	/**
	 * Per-call request timeout in milliseconds. @default 30000
	 */
	timeoutMs?: number;
}

function resolveModel(options: CompactorModelOptions): LanguageModel {
	try {
		return createLanguageModel({
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
			model: options.model,
			languageModel: options.languageModel,
			providerType: options.providerType,
			providerName: "opencontext-compactor",
		});
	} catch (err) {
		// Preserve the historical error message ("Compactor API key is required")
		// so existing callers / tests don't break.
		if (err instanceof Error && /LLM API key is required/.test(err.message)) {
			throw new Error(
				"Compactor API key is required. Set OPENCONTEXT_LLM_API_KEY or pass apiKey to createCompactor().",
			);
		}
		throw err;
	}
}

/**
 * Create a {@link Compactor} backed by an OpenAI-compatible or Anthropic-compatible LLM.
 *
 * The factory is intentionally thin: it resolves a model from the supplied
 * options / `OPENCONTEXT_LLM_*` env vars (auto-detecting Anthropic-compatible
 * endpoints via the baseUrl substring) and wires it to `runCompactor` from
 * `@melandlabs/ai`. Hosts then attach the resulting object to
 * `AgentConfig.providerConfig.compactor` so any `IAgent` (Standalone, Claude,
 * Codex, OpenCode, ACP, Hermes, OpenClaw) inherits `compactContext` from
 * `BaseAgent`.
 */
export function createCompactor(modelOptions: CompactorModelOptions = {}): Compactor {
	const model = resolveModel(modelOptions);
	const timeoutMs = modelOptions.timeoutMs ?? 30_000;

	return {
		async compact(input: CompactContextInput): Promise<CompactContextResult> {
			const options: RunCompactorOptions = {
				timeoutMs,
				preprocessOptions: input.preprocessOptions,
			};
			return runCompactor(model, input, options);
		},
	};
}

/**
 * No-op compactor for hosts that do not want in-process summarization. Calling
 * `compact()` on this throws — same pattern as `createDisabledMemoryReasoningProviders`
 * surfaces a clear error rather than silently no-opping.
 */
export function createDisabledCompactor(): Compactor {
	return {
		async compact(_input: CompactContextInput): Promise<CompactContextResult> {
			throw new Error("compactor disabled");
		},
	};
}
