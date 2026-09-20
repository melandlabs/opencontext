import type { LanguageModel } from "ai";
/**
 * @melandlabs/opencontext — llm-factory unit tests.
 *
 * `createAnthropic` and `createOpenAICompatible` are stubbed via
 * `vi.mock("@ai-sdk/anthropic")` / `vi.mock("@ai-sdk/openai-compatible")`
 * so we can assert the resolution logic without any network access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const anthropicLanguageModelMock = vi.fn();
	const anthropicProviderMock = vi.fn((_options?: unknown) => ({
		languageModel: anthropicLanguageModelMock,
	}));
	const openAIChatModelMock = vi.fn();
	const openAIProviderMock = vi.fn((_options?: unknown) => ({
		chatModel: openAIChatModelMock,
	}));
	return {
		anthropicLanguageModelMock,
		anthropicProviderMock,
		openAIChatModelMock,
		openAIProviderMock,
	};
});

vi.mock("@ai-sdk/anthropic", () => ({
	createAnthropic: mocks.anthropicProviderMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: mocks.openAIProviderMock,
}));

import {
	createLanguageModel,
	detectProviderType,
	normalizeAnthropicBaseUrl,
	readLLMEnv,
} from "./llm-factory";

const { anthropicLanguageModelMock, anthropicProviderMock, openAIChatModelMock, openAIProviderMock } = mocks;

function fakeModel(): LanguageModel {
	return {
		specificationVersion: "v1",
		provider: "test-provider",
		modelId: "test-model",
		defaultObjectGenerationMode: "json",
		doGenerate: vi.fn(),
		doStream: vi.fn(),
	} as unknown as LanguageModel;
}

describe("detectProviderType", () => {
	it("defaults to openai_compatible when baseUrl is empty", () => {
		expect(detectProviderType(undefined)).toBe("openai_compatible");
		expect(detectProviderType(null)).toBe("openai_compatible");
		expect(detectProviderType("")).toBe("openai_compatible");
	});

	it("detects anthropic_compatible from baseUrl substring (case-insensitive)", () => {
		expect(detectProviderType("https://api.anthropic.com/v1")).toBe("anthropic_compatible");
		expect(detectProviderType("https://ANTHROPIC.proxy.example/v1")).toBe("anthropic_compatible");
		expect(detectProviderType("https://my-proxy.com/anthropic-compatible/v1")).toBe("anthropic_compatible");
	});

	it("treats openrouter / deepseek / openai baseUrls as openai_compatible", () => {
		expect(detectProviderType("https://openrouter.ai/api/v1")).toBe("openai_compatible");
		expect(detectProviderType("https://api.deepseek.com/v1")).toBe("openai_compatible");
		expect(detectProviderType("https://api.openai.com/v1")).toBe("openai_compatible");
	});
});

describe("normalizeAnthropicBaseUrl", () => {
	it("appends /v1 when missing", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
	});

	it("strips trailing slashes before appending", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com///")).toBe("https://api.anthropic.com/v1");
	});

	it("is idempotent when /v1 already present", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1");
	});
});

describe("readLLMEnv", () => {
	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: env-reset pattern (assigning undefined coerces to "undefined" string).
		delete process.env.OPENCONTEXT_LLM_API_KEY;
		// biome-ignore lint/performance/noDelete: env-reset pattern
		delete process.env.OPENCONTEXT_LLM_BASE_URL;
		// biome-ignore lint/performance/noDelete: env-reset pattern
		delete process.env.OPENCONTEXT_LLM_MODEL;
	});

	it("returns nulls when env vars are absent", () => {
		const env = readLLMEnv();
		expect(env.apiKey).toBeNull();
		expect(env.baseUrl).toBeNull();
		expect(env.model).toBeNull();
	});

	it("reads from process.env by default", () => {
		process.env.OPENCONTEXT_LLM_API_KEY = "k";
		process.env.OPENCONTEXT_LLM_BASE_URL = "https://api.deepseek.com/v1";
		process.env.OPENCONTEXT_LLM_MODEL = "deepseek-chat";
		const env = readLLMEnv();
		expect(env.apiKey).toBe("k");
		expect(env.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(env.model).toBe("deepseek-chat");
	});
});

describe("createLanguageModel", () => {
	beforeEach(() => {
		anthropicLanguageModelMock.mockReset();
		anthropicProviderMock.mockClear();
		openAIChatModelMock.mockReset();
		openAIProviderMock.mockClear();
	});

	it("returns the supplied pre-built languageModel without touching any provider", () => {
		const model = fakeModel();
		const result = createLanguageModel({ languageModel: model });
		expect(result).toBe(model);
		expect(anthropicProviderMock).not.toHaveBeenCalled();
		expect(openAIProviderMock).not.toHaveBeenCalled();
	});

	it("auto-detects anthropic_compatible from baseUrl", () => {
		anthropicLanguageModelMock.mockReturnValueOnce(fakeModel());
		const env = { apiKey: "k", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest" };

		createLanguageModel({}, env);

		expect(anthropicProviderMock).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.anthropic.com/v1", apiKey: "k" }),
		);
		expect(anthropicLanguageModelMock).toHaveBeenCalledWith("claude-3-5-sonnet-latest");
		expect(openAIProviderMock).not.toHaveBeenCalled();
	});

	it("normalizes missing /v1 on the anthropic baseUrl", () => {
		anthropicLanguageModelMock.mockReturnValueOnce(fakeModel());
		const env = { apiKey: "k", baseUrl: "https://api.anthropic.com", model: "claude-3-5-sonnet-latest" };

		createLanguageModel({}, env);

		expect(anthropicProviderMock).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.anthropic.com/v1" }),
		);
	});

	it("explicit providerType overrides auto-detection", () => {
		openAIChatModelMock.mockReturnValueOnce(fakeModel());
		// baseUrl says anthropic, but explicit providerType says openai_compatible.
		const env = { apiKey: "k", baseUrl: "https://api.anthropic.com/v1", model: "gpt-4o-mini" };

		createLanguageModel({ providerType: "openai_compatible" }, env);

		expect(openAIProviderMock).toHaveBeenCalled();
		expect(anthropicProviderMock).not.toHaveBeenCalled();
	});

	it("routes openai_compatible endpoints to createOpenAICompatible", () => {
		openAIChatModelMock.mockReturnValueOnce(fakeModel());
		const env = { apiKey: "k", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };

		createLanguageModel({}, env);

		expect(openAIProviderMock).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.deepseek.com/v1", apiKey: "k" }),
		);
		expect(openAIChatModelMock).toHaveBeenCalledWith("deepseek-chat");
		expect(anthropicProviderMock).not.toHaveBeenCalled();
	});

	it("throws when no api key is supplied and no env is set", () => {
		expect(() => createLanguageModel({}, { apiKey: null, baseUrl: "x", model: "y" })).toThrow(
			/LLM API key is required/,
		);
	});

	it("passes through options.apiKey when env is missing", () => {
		openAIChatModelMock.mockReturnValueOnce(fakeModel());

		createLanguageModel(
			{ apiKey: "explicit", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
			{ apiKey: null, baseUrl: null, model: null },
		);

		expect(openAIProviderMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "explicit" }));
	});

	it("uses defaults when no model is provided", () => {
		openAIChatModelMock.mockReturnValueOnce(fakeModel());
		const env = { apiKey: "k", baseUrl: null, model: null };

		createLanguageModel({ providerType: "openai_compatible" }, env);

		expect(openAIChatModelMock).toHaveBeenCalledWith("openai/gpt-4o-mini");
	});
});
