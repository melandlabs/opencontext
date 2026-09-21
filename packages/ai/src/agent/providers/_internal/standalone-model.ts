/**
 * Build the AI SDK `LanguageModel` used by `StandaloneAgent`.
 *
 * Pulled out of `standalone.ts` so the env-priority semantics can be unit
 * tested in isolation. When the host supplies explicit credentials on the
 * `AgentConfig`, those win over `process.env.ANTHROPIC_API_KEY` /
 * `ANTHROPIC_BASE_URL` and the global `setAIUserContext()` bag — this is
 * the env-priority fix that lets downstream hosts (e.g. alloomi's
 * `PlatformStandaloneAgent`) pin per-request credentials without having to
 * fork the agent.
 *
 * Two wire protocols are supported on the explicit-credential path:
 *
 * - `anthropic_compatible` (default) — `createAnthropic({ baseURL, apiKey })`
 * - `openai_compatible` — `createOpenAICompatible({ baseURL, apiKey, name })`
 *
 * The discriminator matches the `providerType` carried in
 * `getValidatedEnv`'s return shape (`packages/ai/src/agent/model/providers.ts`),
 * so explicit-credential and env-fallback paths speak the same vocabulary.
 *
 * When either credential is missing, fall through to `createDynamicModel`
 * so existing callers that rely entirely on env + `AIUserContext` keep
 * working unchanged.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { createDynamicModel } from "../../model/providers";

export type StandaloneProviderType = "anthropic_compatible" | "openai_compatible";

export interface CreateStandaloneModelOptions {
	isNativeMode: boolean;
	modelName?: string;
	/**
	 * Explicit credentials win over process env when both are present.
	 * Trimmed before comparison so a stray whitespace-only value still falls
	 * through to the env path.
	 */
	apiKey?: string;
	baseUrl?: string;
	/**
	 * Wire protocol to use when both `apiKey` and `baseUrl` are supplied.
	 * Defaults to `"anthropic_compatible"` for backward compatibility with
	 * the original `StandaloneAgent.runCore` implementation, which hard-coded
	 * `createAnthropic`. Callers that want to hit an OpenAI-compatible
	 * endpoint (e.g. via `providerConfig.providerType`) pass
	 * `"openai_compatible"` here.
	 */
	providerType?: StandaloneProviderType;
}

/**
 * Build the AI SDK `LanguageModel` for `StandaloneAgent`.
 *
 * When both `apiKey` and `baseUrl` are non-empty, build the wire-protocol
 * client directly (`createAnthropic` or `createOpenAICompatible` based on
 * `providerType`) — env / `AIUserContext` are skipped. The baseUrl is
 * normalised so it always ends with `/v1` (matching the existing
 * `getValidatedEnv` behaviour for both Anthropic- and OpenAI-compatible
 * endpoints).
 *
 * When either credential is missing, fall through to `createDynamicModel`
 * so existing callers keep working.
 */
export function createStandaloneModel(opts: CreateStandaloneModelOptions): LanguageModel {
	const apiKey = opts.apiKey?.trim();
	const baseUrl = opts.baseUrl?.trim();
	const providerType: StandaloneProviderType = opts.providerType ?? "anthropic_compatible";

	if (apiKey && baseUrl) {
		const normalized = baseUrl.replace(/\/+$/, "");
		const withV1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;

		if (providerType === "openai_compatible") {
			// `@ai-sdk/openai-compatible` requires a non-empty `name` field
			// for telemetry tagging; mirror the `"dynamic-model"` label used
			// by the env fallback in `packages/ai/src/agent/model/providers.ts`.
			// `@ai-sdk/openai-compatible` ships `LanguageModelV2` already,
			// so no SDK-version bridge is needed for this branch.
			return createOpenAICompatible({
				baseURL: withV1,
				apiKey,
				name: "standalone-model",
			}).chatModel(opts.modelName ?? "");
		}

		// `@ai-sdk/anthropic` ships `LanguageModelV4`, but the `ai` package
		// still types `generateText({ model })` as `LanguageModelV2`. The
		// structural type is derived from the consumer so the cast stays
		// self-documenting when SDK versions shift — see the matching
		// bridge in `packages/ai/src/agent/model/providers.ts`.
		const anthropicModel = createAnthropic({ baseURL: withV1, apiKey }).languageModel(
			opts.modelName ?? "",
		) as unknown as LanguageModel;
		return anthropicModel;
	}

	return createDynamicModel(opts.isNativeMode, opts.modelName);
}
