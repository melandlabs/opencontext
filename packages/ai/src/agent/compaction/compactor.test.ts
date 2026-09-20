/**
 * Unit tests for the in-process compactor. The LLM call is stubbed via
 * `vi.mock("ai")` so the test stays hermetic — the production wiring for the
 * end-to-end path lives in `context-compaction.test.ts` /
 * `context-compaction.integration.test.ts`.
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

import { runCompactor } from "./compactor";

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

describe("runCompactor", () => {
	beforeEach(() => {
		generateTextMock.mockReset();
	});

	it("forwards sanitized messages + level prompt to generateText and returns usage", async () => {
		generateTextMock.mockResolvedValueOnce({
			text: "[COMPACTED: SOFT -- 2 messages summarized]\n## Summary\n...",
			usage: { inputTokens: 120, outputTokens: 35 },
		});

		const result = await runCompactor(fakeModel(), {
			messages: [
				{ role: "user", content: "Tell me about compaction." },
				{ role: "assistant", content: "Compaction summarizes older messages." },
			],
		});

		expect(result.summary).toContain("[COMPACTED: SOFT");
		expect(result.messageCount).toBe(2);
		expect(result.level).toBe("soft");
		expect(result.originalTokens).toBe(120);
		expect(result.summaryTokens).toBe(35);

		expect(generateTextMock).toHaveBeenCalledTimes(1);
		const call = generateTextMock.mock.calls[0][0];
		expect(call.model).toBeDefined();
		expect(call.temperature).toBe(0);
		expect(typeof call.system).toBe("string");
		// Default level is "soft" — the system prompt should mention the soft flavor.
		expect(call.system as string).toMatch(/SOFT/);
		expect(Array.isArray(call.messages)).toBe(true);
		// Both messages must survive sanitization into the model call.
		expect(call.messages).toHaveLength(2);
		expect(call.messages[0].role).toBe("user");
		expect(call.messages[1].role).toBe("assistant");
	});

	it("uses the emergency-flavored system prompt when level === 'emergency'", async () => {
		generateTextMock.mockResolvedValueOnce({
			text: "emergency summary",
			usage: { inputTokens: 5, outputTokens: 5 },
		});

		await runCompactor(fakeModel(), {
			messages: [{ role: "user", content: "hi" }],
			level: "emergency",
		});

		const call = generateTextMock.mock.calls[0][0];
		expect(call.system as string).toMatch(/EMERGENCY/);
	});

	it("throws before invoking the model when the input is empty", async () => {
		await expect(runCompactor(fakeModel(), { messages: [] })).rejects.toThrow(/no messages supplied/);
		expect(generateTextMock).not.toHaveBeenCalled();
	});

	it("throws when sanitization drops every message (whitespace-only payloads)", async () => {
		await expect(
			runCompactor(fakeModel(), {
				messages: [
					{ role: "user", content: "   " },
					{ role: "assistant", content: "\n\n" },
				],
			}),
		).rejects.toThrow(/no messages left after sanitization/);
		expect(generateTextMock).not.toHaveBeenCalled();
	});

	it("propagates generateText rejections", async () => {
		generateTextMock.mockRejectedValueOnce(new Error("upstream boom"));
		await expect(
			runCompactor(fakeModel(), {
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(/upstream boom/);
	});

	it("collapses missing usage counts to 0 instead of NaN", async () => {
		generateTextMock.mockResolvedValueOnce({ text: "ok" });

		const result = await runCompactor(fakeModel(), {
			messages: [{ role: "user", content: "hi" }],
		});
		expect(result.originalTokens).toBe(0);
		expect(result.summaryTokens).toBe(0);
	});
});
