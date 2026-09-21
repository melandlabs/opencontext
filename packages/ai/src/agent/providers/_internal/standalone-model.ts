/**
 * Build the AI SDK `LanguageModel` used by `StandaloneAgent` from explicit
 * credentials.
 *
 * Pulled out of `standalone.ts` so the explicit-credential semantics can be
 * unit tested in isolation. The helper is laser-focused: it only knows how
 * to build a model from a `apiKey` + `baseUrl` pair, and throws when
 * either is missing — `StandaloneAgent` no longer falls back to
 * `createDynamicModel`, so env + `setAIUserContext()` callers must migrate
 * to passing credentials explicitly.
 *
 * When the host supplies both credentials, those win over `process.env`
 * and the global user-context bag — this is the env-priority fix that lets
 * downstream hosts (e.g. alloomi's `PlatformStandaloneAgent`) pin per-
 * request credentials without having to fork the agent.
 *
 * Two wire protocols are supported:
 *
 * - `anthropic_compatible` (default) — `createAnthropic({ baseURL, apiKey })`
 * - `openai_compatible` — `createOpenAICompatible({ baseURL, apiKey, name })`
 *
 * The discriminator matches the `providerType` carried in
 * `getValidatedEnv`'s return shape (`packages/ai/src/agent/model/providers.ts`).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type StandaloneProviderType = "anthropic_compatible" | "openai_compatible";

export interface CreateStandaloneModelOptions {
	modelName?: string;
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
 * Build the AI SDK `LanguageModel` for `StandaloneAgent` from explicit
 * credentials. Throws when either `apiKey` or `baseUrl` is missing — the
 * caller (typically `StandaloneAgent.runCore`) is expected to surface the
 * error to its caller as an `upstream_error` `AgentMessage`.
 *
 * The baseUrl is normalised so it always ends with `/v1` (matching the
 * existing `getValidatedEnv` behaviour for both Anthropic- and OpenAI-
 * compatible endpoints).
 */
export function createStandaloneModel(opts: CreateStandaloneModelOptions): LanguageModel {
	const apiKey = opts.apiKey?.trim();
	const baseUrl = opts.baseUrl?.trim();

	if (!apiKey || !baseUrl) {
		const missing: string[] = [];
		if (!apiKey) missing.push("`apiKey`");
		if (!baseUrl) missing.push("`baseUrl`");
		throw new Error(
			`createStandaloneModel: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required. StandaloneAgent no longer falls back to process.env / setAIUserContext(); pass credentials explicitly on AgentConfig.`,
		);
	}

	const providerType: StandaloneProviderType = opts.providerType ?? "anthropic_compatible";
	const normalized = baseUrl.replace(/\/+$/, "");
	const withV1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;

	if (providerType === "openai_compatible") {
		// `@ai-sdk/openai-compatible` requires a non-empty `name` field
		// for telemetry tagging; mirror the `"dynamic-model"` label used
		// by the env fallback in `packages/ai/src/agent/model/providers.ts`.
		// `@ai-sdk/openai-compatible` ships `LanguageModelV2` already, so
		// no SDK-version bridge is needed for this branch.
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
