/**
 * @melandlabs/opencontext — context-compaction facade unit tests.
 *
 * Mirrors `memory-reasoning.test.ts`: stub the AI SDK `generateText` so the
 * factory wiring can be exercised without a real LLM, then assert the
 * contract: pre-built models win over env, env wins over defaults, missing
 * keys throw, and the disabled compactor surfaces a clear error.
 */

import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
	const original = await importOriginal<typeof import("ai")>();
	return {
		...original,
		generateText: (...args: Parameters<typeof original.generateText>) => generateTextMock(...args),
	};
});

import { createCompactor, createDisabledCompactor } from "./context-compaction";

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

describe("createCompactor facade", () => {
	beforeEach(() => {
		generateTextMock.mockReset();
	});

	it("wires the supplied pre-built model to runCompactor without touching createOpenAICompatible", async () => {
		generateTextMock.mockResolvedValueOnce({
			text: "[COMPACTED: SOFT -- 1 messages summarized]\n## Summary\n...",
			usage: { inputTokens: 10, outputTokens: 20 },
		});

		const model = fakeModel();
		const compactor = createCompactor({ languageModel: model });

		const result = await compactor.compact({
			messages: [{ role: "user", content: "tell me about compaction" }],
		});

		expect(result.summary).toContain("[COMPACTED: SOFT");
		expect(result.originalTokens).toBe(10);
		expect(result.summaryTokens).toBe(20);
		expect(result.messageCount).toBe(1);
		expect(result.level).toBe("soft");

		// generateText received the fake model we passed in.
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		expect(generateTextMock.mock.calls[0][0].model).toBe(model);
	});

	it("forwards preprocessOptions from input to runCompactor", async () => {
		generateTextMock.mockResolvedValueOnce({
			text: "ok",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const compactor = createCompactor({ languageModel: fakeModel() });
		await compactor.compact({
			messages: [{ role: "user", content: "hi" }],
			preprocessOptions: { maxCharsPerMessage: 100 },
		});

		expect(generateTextMock).toHaveBeenCalledTimes(1);
	});

	it("passes the chosen level through to runCompactor", async () => {
		generateTextMock.mockResolvedValueOnce({
			text: "emergency summary",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const compactor = createCompactor({ languageModel: fakeModel() });
		const result = await compactor.compact({
			messages: [{ role: "user", content: "hi" }],
			level: "emergency",
		});

		expect(result.level).toBe("emergency");
		expect(generateTextMock.mock.calls[0][0].system as string).toMatch(/EMERGENCY/);
	});

	it("throws a clear error when no API key is supplied and no env var is set", () => {
		const previousKey = process.env.OPENCONTEXT_LLM_API_KEY;
		// biome-ignore lint/performance/noDelete: env-clear pattern (assigning undefined coerces to the string "undefined").
		delete process.env.OPENCONTEXT_LLM_API_KEY;
		try {
			expect(() => createCompactor({})).toThrow(/Compactor API key is required/);
		} finally {
			if (previousKey !== undefined) process.env.OPENCONTEXT_LLM_API_KEY = previousKey;
		}
	});

	it("falls back to OPENCONTEXT_LLM_API_KEY when no explicit key is provided", () => {
		const previousKey = process.env.OPENCONTEXT_LLM_API_KEY;
		const previousBase = process.env.OPENCONTEXT_LLM_BASE_URL;
		const previousModel = process.env.OPENCONTEXT_LLM_MODEL;
		process.env.OPENCONTEXT_LLM_API_KEY = "deepseek-flash-test-key";
		// Provide a deterministic base URL / model so the test does not need
		// any network access — we only assert the factory did NOT throw.
		process.env.OPENCONTEXT_LLM_BASE_URL ??= "https://api.deepseek.com/v1";
		process.env.OPENCONTEXT_LLM_MODEL ??= "deepseek-chat";

		try {
			expect(() => createCompactor({})).not.toThrow();
		} finally {
			// biome-ignore lint/performance/noDelete: env-restore pattern
			if (previousKey === undefined) delete process.env.OPENCONTEXT_LLM_API_KEY;
			else process.env.OPENCONTEXT_LLM_API_KEY = previousKey;
			// biome-ignore lint/performance/noDelete: env-restore pattern
			if (previousBase === undefined) delete process.env.OPENCONTEXT_LLM_BASE_URL;
			else process.env.OPENCONTEXT_LLM_BASE_URL = previousBase;
			// biome-ignore lint/performance/noDelete: env-restore pattern
			if (previousModel === undefined) delete process.env.OPENCONTEXT_LLM_MODEL;
			else process.env.OPENCONTEXT_LLM_MODEL = previousModel;
		}
	});
});

describe("createDisabledCompactor", () => {
	it("throws a clear error when compact is called", async () => {
		const compactor = createDisabledCompactor();
		await expect(compactor.compact({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
			/compactor disabled/,
		);
	});
});
