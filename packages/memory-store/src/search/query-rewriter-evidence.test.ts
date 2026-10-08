import { describe, expect, it, vi } from "vitest";
import { createUserVoiceRewriter } from "./query-rewriter";

describe("opt-in evidence retrieval expressions", () => {
	it("keeps original-first order, bounds alternatives and deduplicates", async () => {
		const complete = vi.fn(
			async (_prompt: string) =>
				"- past traffic simulation speed variability\n- my traffic simulation requirements\n- My traffic simulation requirements\n- my prior speed distribution choice\n- ignored excess",
		);
		const rewrite = createUserVoiceRewriter({ complete, style: "evidence", maxVariants: 3 });
		const result = await rewrite.rewrite({
			userId: "u",
			query: "How should I add traffic speed variability?",
		});
		expect(result).toEqual([
			"How should I add traffic speed variability?",
			"past traffic simulation speed variability",
			"my traffic simulation requirements",
			"my prior speed distribution choice",
		]);
		expect(complete.mock.calls[0][0]).toContain("never invent their values or assume an answer");
		expect(complete.mock.calls[0][0]).toContain("Do not invent dates");
	});
	it("preserves default prompts and provider failure fallback", async () => {
		const legacy = vi.fn(async (_prompt: string) => "- Did I mention my favorite color?");
		await createUserVoiceRewriter({ complete: legacy }).rewrite({ userId: "u", query: "My favorite color?" });
		expect(legacy.mock.calls[0][0]).toContain("Output exactly 1 alternative rephrasing");
		expect(legacy.mock.calls[0][0]).not.toContain("Generate retrieval expressions");
		const failed = createUserVoiceRewriter({
			style: "evidence",
			maxVariants: 3,
			complete: async () => {
				throw new Error("offline");
			},
		});
		expect(await failed.rewrite({ userId: "u", query: "Original question?" })).toEqual([
			"Original question?",
		]);
		expect(failed.lastDegraded?.()).toBe(true);
	});
});
