/**
 * @melandlabs/opencontext — shared LLM factory.
 *
 * Resolves a {@link LanguageModel} for downstream callers
 * (`createMemoryReasoningProviders`, `createCompactor`, anything else that
 * needs an OpenAI-compatible or Anthropic-compatible chat model).
 *
 * Provider selection is exactly the same pattern used by
 * `packages/ai/src/agent/model/providers.ts` (`LLMProviderType`):
 *
 *   1. Explicit `providerType` wins.
 *   2. If `baseUrl` is supplied and contains the substring `"anthropic"`
 *      (case-insensitive), auto-select `anthropic_compatible`.
 *   3. Otherwise default to `openai_compatible`.
 *
 * Auto-detect is gated on the *baseUrl* (not the env var) because the
 * baseUrl is what actually contacts the wire — a `OPENCONTEXT_LLM_MODEL`
 * of `anthropic/claude-3-5-sonnet` is fine on OpenRouter's OpenAI-compatible
 * surface, so the substring in the URL is the only reliable signal.
 *
 * Anthropic baseUrls auto-get `/v1` appended if missing
 * (`https://api.anthropic.com` → `https://api.anthropic.com/v1`), matching
 * the precedent in `agent/model/providers.ts`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type LLMProviderType = "openai_compatible" | "anthropic_compatible";

/** Provider-prefixed env defaults — `null` means "no env value resolved". */
export interface LLMEnvDefaults {
	apiKey: string | null;
	baseUrl: string | null;
	model: string | null;
}

/**
 * Options for {@link createLanguageModel}. Mirrors the field shape of
 * `ReasoningModelOptions` / `CompactorModelOptions` so existing callers
 * upgrade without churn.
 */
export interface LanguageModelFactoryOptions {
	/** OpenAI-compatible or Anthropic-compatible API key. */
	apiKey?: string;
	/** OpenAI-compatible or Anthropic-compatible base URL. */
	baseUrl?: string;
	/** Model identifier (provider-specific). */
	model?: string;
	/** Pre-built model — wins over the apiKey/baseUrl/model trio. */
	languageModel?: LanguageModel;
	/**
	 * Force a provider. When omitted, the factory inspects `baseUrl` for the
	 * substring `"anthropic"` (case-insensitive). An explicit value wins.
	 */
	providerType?: LLMProviderType;
	/** Override the default OpenAI-compatible base URL. */
	defaultOpenAIBaseUrl?: string;
	/** Override the default Anthropic-compatible base URL. */
	defaultAnthropicBaseUrl?: string;
	/** Override the default model name. */
	defaultModel?: string;
	/**
	 * Display name passed to `createOpenAICompatible({ name })`. Useful for
	 * provider-side telemetry / rate-limit attribution.
	 */
	providerName?: string;
}

/**
 * Read env defaults. Each call returns `null` (not `undefined`) for absent
 * values so the caller can distinguish "env explicitly unset" from "env not
 * checked". Tests can override the resolved values by passing the same
 * option shape with explicit fields.
 */
export function readLLMEnv(env: NodeJS.ProcessEnv = process.env): LLMEnvDefaults {
	return {
		apiKey: env.OPENCONTEXT_LLM_API_KEY ?? null,
		baseUrl: env.OPENCONTEXT_LLM_BASE_URL ?? null,
		model: env.OPENCONTEXT_LLM_MODEL ?? null,
	};
}

/**
 * Resolve the provider type from the supplied baseUrl when the caller did
 * not set `providerType` explicitly. Case-insensitive substring match on
 * `"anthropic"`. Non-URL strings still match if they contain the token.
 */
export function detectProviderType(baseUrl: string | undefined | null): LLMProviderType {
	if (!baseUrl) return "openai_compatible";
	return baseUrl.toLowerCase().includes("anthropic") ? "anthropic_compatible" : "openai_compatible";
}

/**
 * Normalize an Anthropic-compatible base URL. Anthropic's wire API requires
 * the path to end in `/v1` (some providers strip it; some don't ship it).
 * Idempotent — passing a URL that already ends in `/v1` is a no-op.
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve a {@link LanguageModel} from the supplied options + env fallback.
 *
 * Throws with a descriptive message when neither a pre-built `languageModel`
 * nor a resolvable API key is supplied.
 */
export function createLanguageModel(
	options: LanguageModelFactoryOptions = {},
	env: LLMEnvDefaults = readLLMEnv(),
): LanguageModel {
	if (options.languageModel) return options.languageModel;

	const apiKey = options.apiKey ?? env.apiKey ?? "";
	const providerType: LLMProviderType =
		options.providerType ?? detectProviderType(options.baseUrl ?? env.baseUrl ?? undefined);

	if (!apiKey) {
		throw new Error("LLM API key is required. Set OPENCONTEXT_LLM_API_KEY or pass apiKey to the factory.");
	}

	if (providerType === "anthropic_compatible") {
		const rawBaseUrl =
			options.baseUrl ?? env.baseUrl ?? options.defaultAnthropicBaseUrl ?? "https://api.anthropic.com/v1";
		const baseUrl = normalizeAnthropicBaseUrl(rawBaseUrl);
		const modelId = options.model ?? env.model ?? options.defaultModel ?? "claude-3-5-sonnet-latest";
		return createAnthropic({ baseURL: baseUrl, apiKey }).languageModel(modelId) as unknown as LanguageModel;
	}

	const baseUrl =
		options.baseUrl ?? env.baseUrl ?? options.defaultOpenAIBaseUrl ?? "https://openrouter.ai/api/v1";
	const modelId = options.model ?? env.model ?? options.defaultModel ?? "openai/gpt-4o-mini";
	return createOpenAICompatible({
		baseURL: baseUrl,
		apiKey,
		name: options.providerName ?? "opencontext-llm",
	}).chatModel(modelId);
}
