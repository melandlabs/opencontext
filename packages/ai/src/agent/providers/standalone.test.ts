/**
 * Unit tests for `StandaloneAgent.runCore` and its underlying
 * `createStandaloneModel` / `readImageParts` helpers.
 *
 * The plan: pin `createStandaloneModel`'s env-priority semantics (explicit
 * credentials win over process env) and the new option-forwarding surface
 * (`systemPrompt` / `aiSoulPrompt`, `conversation`, `extraHeaders`,
 * `imagePaths`) on the upstream `StandaloneAgent` so downstream consumers can
 * pin credentials, headers, and multimodal attachments without forking the
 * agent locally.
 *
 * Mocking pattern mirrors `providers/claude/index.test.ts`: hoisted
 * `vi.hoisted` factories let `vi.mock("ai", ...)` and
 * `vi.mock("../model/providers", ...)` reach the same mocks the
 * implementation imports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentMessage } from "../types";

const generateTextMock = vi.hoisted(() => vi.fn());
const createAnthropicMock = vi.hoisted(() => vi.fn());
const createOpenAICompatibleMock = vi.hoisted(() => vi.fn());
const languageModelMock = vi.hoisted(() => vi.fn());
const chatModelMock = vi.hoisted(() => vi.fn());
const createDynamicModelMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
	generateText: generateTextMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
	createAnthropic: createAnthropicMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("../model/providers", async () => {
	const actual = await vi.importActual<typeof import("../model/providers")>("../model/providers");
	return {
		...actual,
		createDynamicModel: createDynamicModelMock,
	};
});

vi.mock("node:fs/promises", () => ({
	readFile: readFileMock,
}));

import { createStandaloneModel } from "./_internal/standalone-model";
import { createStandaloneAgent } from "./standalone";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		provider: "standalone",
		model: "claude-test-model",
		apiKey: "test-key",
		baseUrl: "https://example.com",
		...overrides,
	};
}

function makeGenerateTextResult(text: string) {
	return {
		text,
		usage: {
			inputTokens: 7,
			outputTokens: 5,
			totalTokens: 12,
		},
	};
}

async function collectMessages(generator: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
	const messages: AgentMessage[] = [];
	for await (const message of generator) {
		messages.push(message);
	}
	return messages;
}

beforeEach(() => {
	generateTextMock.mockReset();
	createAnthropicMock.mockReset();
	createOpenAICompatibleMock.mockReset();
	languageModelMock.mockReset();
	chatModelMock.mockReset();
	createDynamicModelMock.mockReset();
	readFileMock.mockReset();

	// `createAnthropic(...).languageModel(...)` is what the production code
	// chains when explicit credentials + anthropic_compatible are present.
	// Wire the two mocks so the chain returns a deterministic sentinel.
	languageModelMock.mockImplementation((modelId: string) => ({ __anthropicModel: modelId }));
	createAnthropicMock.mockImplementation(() => ({ languageModel: languageModelMock }));

	// `createOpenAICompatible(...).chatModel(...)` is what the production
	// code chains when explicit credentials + openai_compatible are present.
	chatModelMock.mockImplementation((modelId: string) => ({ __openaiModel: modelId }));
	createOpenAICompatibleMock.mockImplementation(() => ({ chatModel: chatModelMock }));

	// Default `createDynamicModel` returns a distinct sentinel so we can
	// tell the env-fallback path apart from the explicit-credential path.
	createDynamicModelMock.mockImplementation((_isNativeMode: boolean, modelName?: string) => ({
		__dynamicModel: modelName ?? "<no-model>",
	}));

	// Default `generateText` resolves with a canned result. Individual tests
	// override this to capture call arguments.
	generateTextMock.mockResolvedValue(makeGenerateTextResult("ok"));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("createStandaloneModel", () => {
	it("builds an Anthropic client from explicit apiKey + baseUrl (env-priority fix)", () => {
		const model = createStandaloneModel({
			modelName: "claude-test-model",
			apiKey: "explicit-key",
			baseUrl: "https://example.com",
		});

		expect(createAnthropicMock).toHaveBeenCalledTimes(1);
		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
		expect(languageModelMock).toHaveBeenCalledWith("claude-test-model");
		expect(model).toEqual({ __anthropicModel: "claude-test-model" });
	});

	it("appends /v1 only when the baseUrl does not already end in /v1", () => {
		createStandaloneModel({
			apiKey: "explicit-key",
			baseUrl: "https://example.com/v1",
		});

		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
	});

	it("trims trailing slashes on the baseUrl before appending /v1", () => {
		createStandaloneModel({
			apiKey: "explicit-key",
			baseUrl: "https://example.com/",
		});

		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
	});

	it("trims whitespace around apiKey and baseUrl", () => {
		createStandaloneModel({
			apiKey: "  explicit-key  ",
			baseUrl: "  https://example.com  ",
		});

		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
	});

	it("throws and does not call any client when apiKey is missing", () => {
		expect(() =>
			createStandaloneModel({
				baseUrl: "https://example.com",
			}),
		).toThrow(/`apiKey`/);
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
	});

	it("throws and does not call any client when baseUrl is missing", () => {
		expect(() =>
			createStandaloneModel({
				apiKey: "explicit-key",
			}),
		).toThrow(/`baseUrl`/);
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
	});

	it("throws and lists both missing credentials when both are absent", () => {
		expect(() => createStandaloneModel({})).toThrow(/`apiKey` and `baseUrl`/);
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
	});

	it("throws when both credentials are whitespace-only (treated as missing)", () => {
		expect(() =>
			createStandaloneModel({
				apiKey: "   ",
				baseUrl: "   ",
			}),
		).toThrow(/apiKey.*baseUrl|baseUrl.*apiKey/);
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
	});

	it("defaults the model id passed to languageModel to the empty string when no modelName is set", () => {
		createStandaloneModel({
			apiKey: "explicit-key",
			baseUrl: "https://example.com",
		});

		expect(languageModelMock).toHaveBeenCalledWith("");
	});

	it("ignores ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL when explicit credentials are supplied", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
		vi.stubEnv("ANTHROPIC_BASE_URL", "https://env.example.com");

		createStandaloneModel({
			apiKey: "explicit-key",
			baseUrl: "https://example.com",
		});

		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
	});

	describe("openai_compatible providerType", () => {
		it("builds an OpenAI-compatible client from explicit apiKey + baseUrl", () => {
			const model = createStandaloneModel({
				modelName: "gpt-test-model",
				apiKey: "openai-key",
				baseUrl: "https://api.example.com",
				providerType: "openai_compatible",
			});

			expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
			expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
				baseURL: "https://api.example.com/v1",
				apiKey: "openai-key",
				name: "standalone-model",
			});
			expect(chatModelMock).toHaveBeenCalledWith("gpt-test-model");
			expect(createAnthropicMock).not.toHaveBeenCalled();
			expect(model).toEqual({ __openaiModel: "gpt-test-model" });
		});

		it("does not create an Anthropic client when providerType is openai_compatible", () => {
			createStandaloneModel({
				apiKey: "openai-key",
				baseUrl: "https://api.example.com",
				providerType: "openai_compatible",
			});

			expect(createAnthropicMock).not.toHaveBeenCalled();
		});

		it("appends /v1 to OpenAI-compatible baseUrls just like the Anthropic branch", () => {
			createStandaloneModel({
				apiKey: "openai-key",
				baseUrl: "https://api.example.com/",
				providerType: "openai_compatible",
			});

			expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
				baseURL: "https://api.example.com/v1",
				apiKey: "openai-key",
				name: "standalone-model",
			});
		});

		it("defaults the chat model id to the empty string when no modelName is set", () => {
			createStandaloneModel({
				apiKey: "openai-key",
				baseUrl: "https://api.example.com",
				providerType: "openai_compatible",
			});

			expect(chatModelMock).toHaveBeenCalledWith("");
		});

		it("throws when providerType is openai_compatible but credentials are missing", () => {
			expect(() =>
				createStandaloneModel({
					apiKey: "openai-key",
					providerType: "openai_compatible",
				}),
			).toThrow(/`baseUrl`/);
			expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
		});

		it("ignores env credentials (both ANTHROPIC_* and OPENAI_*) on the OpenAI path", () => {
			vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-env-key");
			vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic-env.example.com");
			vi.stubEnv("OPENAI_API_KEY", "openai-env-key");
			vi.stubEnv("OPENAI_BASE_URL", "https://openai-env.example.com");

			createStandaloneModel({
				apiKey: "explicit-key",
				baseUrl: "https://api.example.com",
				providerType: "openai_compatible",
			});

			expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
				baseURL: "https://api.example.com/v1",
				apiKey: "explicit-key",
				name: "standalone-model",
			});
			expect(createAnthropicMock).not.toHaveBeenCalled();
		});
	});

	describe("providerType default", () => {
		it("defaults to anthropic_compatible when providerType is omitted (backward compat)", () => {
			createStandaloneModel({
				apiKey: "explicit-key",
				baseUrl: "https://example.com",
			});

			expect(createAnthropicMock).toHaveBeenCalledTimes(1);
			expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
		});
	});
});

describe("createStandaloneAgent factory", () => {
	it("wraps StandaloneAgent with the standalone provider", () => {
		const agent = createStandaloneAgent({ provider: "standalone" });
		expect(agent.provider).toBe("standalone");
	});
});

describe("StandaloneAgent.run", () => {
	it("ignores env credentials when config supplies apiKey + baseUrl", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
		vi.stubEnv("ANTHROPIC_BASE_URL", "https://env.example.com");

		const agent = createStandaloneAgent(
			makeConfig({ apiKey: "explicit-key", baseUrl: "https://example.com" }),
		);
		const messages = await collectMessages(agent.run("hello"));

		expect(createAnthropicMock).toHaveBeenCalledWith({
			baseURL: "https://example.com/v1",
			apiKey: "explicit-key",
		});
		expect(createDynamicModelMock).not.toHaveBeenCalled();
		// Sanity: the explicit baseUrl, not the env one, made it into the
		// client configuration.
		const call = createAnthropicMock.mock.calls[0]?.[0] as { baseURL: string };
		expect(call.baseURL).not.toContain("env.example.com");
		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text", content: "ok" })]),
		);
	});

	it("routes explicit credentials to createOpenAICompatible when providerConfig.providerType === 'openai_compatible'", async () => {
		const agent = createStandaloneAgent(
			makeConfig({
				apiKey: "openai-key",
				baseUrl: "https://api.example.com",
				model: "gpt-test-model",
				providerConfig: { providerType: "openai_compatible" },
			}),
		);
		const messages = await collectMessages(agent.run("hello"));

		expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
			baseURL: "https://api.example.com/v1",
			apiKey: "openai-key",
			name: "standalone-model",
		});
		expect(chatModelMock).toHaveBeenCalledWith("gpt-test-model");
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createDynamicModelMock).not.toHaveBeenCalled();
		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text", content: "ok" })]),
		);
	});

	it("yields an upstream_error AgentMessage when no credentials are configured", async () => {
		const agent = createStandaloneAgent(makeConfig({ apiKey: undefined, baseUrl: undefined }));
		const messages = await collectMessages(agent.run("hello"));

		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
		expect(createDynamicModelMock).not.toHaveBeenCalled();
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					kind: {
						kind: "upstream_error",
						message: expect.stringMatching(/createStandaloneModel.*apiKey.*baseUrl/),
					},
				}),
			]),
		);
	});

	it("yields an upstream_error AgentMessage when only apiKey is configured", async () => {
		const agent = createStandaloneAgent(makeConfig({ apiKey: "explicit-key", baseUrl: undefined }));
		const messages = await collectMessages(agent.run("hello"));

		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					kind: {
						kind: "upstream_error",
						message: expect.stringMatching(/`baseUrl`/),
					},
				}),
			]),
		);
	});

	it("yields an upstream_error AgentMessage when only baseUrl is configured", async () => {
		const agent = createStandaloneAgent(makeConfig({ apiKey: undefined, baseUrl: "https://example.com" }));
		const messages = await collectMessages(agent.run("hello"));

		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					kind: {
						kind: "upstream_error",
						message: expect.stringMatching(/`apiKey`/),
					},
				}),
			]),
		);
	});

	it("ignores an unknown providerType value and defaults to anthropic_compatible", async () => {
		const agent = createStandaloneAgent(
			makeConfig({
				apiKey: "explicit-key",
				baseUrl: "https://example.com",
				providerConfig: { providerType: "not-a-real-provider" },
			}),
		);
		await collectMessages(agent.run("hello"));

		expect(createAnthropicMock).toHaveBeenCalledTimes(1);
		expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
	});

	it("does not call createDynamicModel anymore — env fallback is gone", async () => {
		const agent = createStandaloneAgent(makeConfig({ apiKey: undefined, baseUrl: undefined }));
		const messages = await collectMessages(agent.run("hello"));

		expect(createDynamicModelMock).not.toHaveBeenCalled();
		expect(createAnthropicMock).not.toHaveBeenCalled();
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					kind: { kind: "upstream_error", message: expect.any(String) },
				}),
			]),
		);
	});

	it("forwards options.systemPrompt to generateText when supplied", async () => {
		const agent = createStandaloneAgent(
			makeConfig({ apiKey: "explicit-key", baseUrl: "https://example.com" }),
		);
		await collectMessages(agent.run("hi", { systemPrompt: "be terse" }));

		expect(generateTextMock).toHaveBeenCalledTimes(1);
		const call = generateTextMock.mock.calls[0]?.[0] as { system?: string };
		expect(call.system).toBe("be terse");
	});

	it("forwards options.aiSoulPrompt as the system prompt when systemPrompt is absent", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi", { aiSoulPrompt: "be friendly" }));

		const call = generateTextMock.mock.calls[0]?.[0] as { system?: string };
		expect(call.system).toBe("be friendly");
	});

	it("systemPrompt takes precedence over aiSoulPrompt when both are set", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi", { systemPrompt: "explicit", aiSoulPrompt: "fallback" }));

		const call = generateTextMock.mock.calls[0]?.[0] as { system?: string };
		expect(call.system).toBe("explicit");
	});

	it("omits system entirely when neither systemPrompt nor aiSoulPrompt is supplied", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi"));

		const call = generateTextMock.mock.calls[0]?.[0] as { system?: string };
		expect(call.system).toBeUndefined();
	});

	it("prepends options.conversation to messages and appends the prompt as a user message", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(
			agent.run("current question", {
				conversation: [
					{ role: "user", content: "earlier question" },
					{ role: "assistant", content: "earlier answer" },
				],
			}),
		);

		expect(generateTextMock).toHaveBeenCalledTimes(1);
		const call = generateTextMock.mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(call.messages).toEqual([
			{ role: "user", content: "earlier question" },
			{ role: "assistant", content: "earlier answer" },
			{ role: "user", content: "current question" },
		]);
	});

	it("sends only the prompt as a user message when no conversation is supplied", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi"));

		const call = generateTextMock.mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(call.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("forwards options.extraHeaders as headers on generateText", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi", { extraHeaders: { "x-trace-id": "abc-123" } }));

		const call = generateTextMock.mock.calls[0]?.[0] as {
			headers?: Record<string, string>;
		};
		expect(call.headers).toEqual({ "x-trace-id": "abc-123" });
	});

	it("omits the headers key when extraHeaders is not supplied", async () => {
		const agent = createStandaloneAgent(makeConfig());
		await collectMessages(agent.run("hi"));

		const call = generateTextMock.mock.calls[0]?.[0] as {
			headers?: Record<string, string>;
		};
		expect("headers" in call).toBe(false);
	});

	it("forwards the abort signal from options when supplied", async () => {
		const agent = createStandaloneAgent(makeConfig());
		const controller = new AbortController();
		await collectMessages(agent.run("hi", { abortController: controller }));

		const call = generateTextMock.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
		expect(call.abortSignal).toBe(controller.signal);
	});

	it("yields session, text, and result on a successful run", async () => {
		generateTextMock.mockResolvedValueOnce(makeGenerateTextResult("hello back"));

		const agent = createStandaloneAgent(makeConfig());
		const messages = await collectMessages(agent.run("hi"));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "session" }),
				expect.objectContaining({ type: "text", content: "hello back" }),
				expect.objectContaining({
					type: "result",
					content: "hello back",
					usage: { inputTokens: 7, outputTokens: 5 },
				}),
			]),
		);
	});

	it("classifies context-overflow errors via isContextOverflowError", async () => {
		generateTextMock.mockImplementationOnce(() => {
			const err = new Error("prompt is too long: 500000 tokens > 200000") as Error & {
				statusCode?: number;
			};
			err.statusCode = 400;
			throw err;
		});

		const agent = createStandaloneAgent(makeConfig());
		const messages = await collectMessages(agent.run("hi"));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					kind: { kind: "context_overflow", message: expect.any(String) },
				}),
			]),
		);
	});

	describe("imagePaths", () => {
		function stubRead(files: Record<string, Uint8Array | string>): void {
			readFileMock.mockImplementation(async (filePath: string) => {
				const value = files[filePath];
				if (value === undefined) {
					throw new Error(`ENOENT: no such file '${filePath}'`);
				}
				return typeof value === "string" ? new TextEncoder().encode(value) : value;
			});
		}

		it("reads a single png attachment and emits a multimodal user message", async () => {
			const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			stubRead({ "/tmp/cat.png": pngBytes });

			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("describe", {
					conversation: [
						{
							role: "user",
							content: "what is in this image?",
							imagePaths: ["/tmp/cat.png"],
						},
					],
				}),
			);

			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{
					role: string;
					content: string | Array<{ type: string; text?: string; image?: string; mediaType?: string }>;
				}>;
			};
			expect(call.messages).toEqual([
				{
					role: "user",
					content: [
						{ type: "text", text: "what is in this image?" },
						{
							type: "image",
							image: Buffer.from(pngBytes).toString("base64"),
							mediaType: "image/png",
						},
					],
				},
				{ role: "user", content: "describe" },
			]);
		});

		it("supports multiple image attachments per message in path order", async () => {
			const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff]);
			stubRead({
				"/tmp/a.png": pngBytes,
				"/tmp/b.jpg": jpegBytes,
			});

			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("describe both", {
					conversation: [{ role: "user", content: "look", imagePaths: ["/tmp/a.png", "/tmp/b.jpg"] }],
				}),
			);

			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{
					content: Array<{ type: string; mediaType?: string }>;
				}>;
			};
			expect(call.messages[0]?.content.map((m) => m.type)).toEqual(["text", "image", "image"]);
			expect(call.messages[0]?.content[1]?.mediaType).toBe("image/png");
			expect(call.messages[0]?.content[2]?.mediaType).toBe("image/jpeg");
		});

		it("keeps plain string content for messages without imagePaths", async () => {
			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("ok", {
					conversation: [
						{ role: "user", content: "earlier" },
						{ role: "assistant", content: "earlier reply" },
						{ role: "user", content: "later" },
					],
				}),
			);

			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{ role: string; content: unknown }>;
			};
			expect(call.messages).toEqual([
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "earlier reply" },
				{ role: "user", content: "later" },
				{ role: "user", content: "ok" },
			]);
		});

		it("silently drops whitespace-only imagePaths entries and falls back to plain string content", async () => {
			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("hi", {
					conversation: [{ role: "user", content: "see", imagePaths: ["   "] }],
				}),
			);

			expect(readFileMock).not.toHaveBeenCalled();
			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{ role: string; content: unknown }>;
			};
			expect(call.messages).toEqual([
				{ role: "user", content: "see" },
				{ role: "user", content: "hi" },
			]);
		});

		it("rejects unsupported extensions with an upstream_error", async () => {
			const agent = createStandaloneAgent(makeConfig());
			const messages = await collectMessages(
				agent.run("hi", {
					conversation: [{ role: "user", content: "see", imagePaths: ["/tmp/photo.bmp"] }],
				}),
			);

			expect(generateTextMock).not.toHaveBeenCalled();
			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "error",
						kind: {
							kind: "upstream_error",
							message: expect.stringMatching(/unsupported image extension/),
						},
					}),
				]),
			);
		});

		it("rejects missing files with an upstream_error", async () => {
			readFileMock.mockRejectedValue(new Error("ENOENT: no such file"));

			const agent = createStandaloneAgent(makeConfig());
			const messages = await collectMessages(
				agent.run("hi", {
					conversation: [{ role: "user", content: "see", imagePaths: ["/tmp/does-not-exist.png"] }],
				}),
			);

			expect(generateTextMock).not.toHaveBeenCalled();
			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "error",
						kind: {
							kind: "upstream_error",
							message: expect.stringMatching(/failed to read image/),
						},
					}),
				]),
			);
		});

		it("skips whitespace-only imagePaths entries when other paths are valid", async () => {
			const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			stubRead({ "/tmp/cat.png": pngBytes });

			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("describe", {
					conversation: [{ role: "user", content: "see", imagePaths: ["   ", "/tmp/cat.png"] }],
				}),
			);

			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{ content: Array<{ type: string }> }>;
			};
			// One text + one image — the blank path is filtered out before
			// hitting `readImageParts`.
			expect(call.messages[0]?.content).toHaveLength(2);
			expect(call.messages[0]?.content.map((m) => m.type)).toEqual(["text", "image"]);
		});

		it("keeps assistant and system messages as plain string content", async () => {
			const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			stubRead({ "/tmp/cat.png": pngBytes });

			const agent = createStandaloneAgent(makeConfig());
			await collectMessages(
				agent.run("describe", {
					conversation: [
						{ role: "system", content: "you are a helpful assistant" },
						{ role: "user", content: "see", imagePaths: ["/tmp/cat.png"] },
						{ role: "assistant", content: "i see" },
					],
				}),
			);

			const call = generateTextMock.mock.calls[0]?.[0] as {
				messages: Array<{ role: string; content: unknown }>;
			};
			expect(call.messages[0]).toEqual({
				role: "system",
				content: "you are a helpful assistant",
			});
			expect(call.messages[1]?.role).toBe("user");
			expect(Array.isArray(call.messages[1]?.content)).toBe(true);
			expect(call.messages[2]).toEqual({ role: "assistant", content: "i see" });
		});
	});
});
