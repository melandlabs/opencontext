import { describe, expect, it, vi } from "vitest";

import { type QueryRewriterOptions, createIdentityRewriter, createUserVoiceRewriter } from "./query-rewriter";

function createRewriter(
	complete: QueryRewriterOptions["complete"],
	overrides?: Partial<QueryRewriterOptions>,
) {
	return createUserVoiceRewriter({ complete, ...overrides });
}

describe("createUserVoiceRewriter", () => {
	it("returns original query plus rewritten variant by default", async () => {
		const complete = vi.fn().mockResolvedValue("- Did I tell you the name of my cat?");
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "What is my cat's name?", userId: "u1" });

		expect(variants).toHaveLength(2);
		expect(variants[0]).toBe("What is my cat's name?");
		expect(variants[1]).toBe("Did I tell you the name of my cat?");
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("strips markdown, quotes, and prefixes from the model output", async () => {
		const complete = vi.fn().mockResolvedValue('- "Rewritten: Did I tell you about my cat?"');
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "cat name", userId: "u1" });

		expect(variants).toEqual(["cat name", "Did I tell you about my cat?"]);
	});

	it("falls back to original query when the model returns empty output", async () => {
		const complete = vi.fn().mockResolvedValue("   ");
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "cat name", userId: "u1" });

		expect(variants).toEqual(["cat name"]);
	});

	it("falls back to original query when the model returns the same text", async () => {
		const complete = vi.fn().mockResolvedValue("cat name");
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "cat name", userId: "u1" });

		expect(variants).toEqual(["cat name"]);
	});

	it("falls back gracefully when complete throws", async () => {
		const complete = vi.fn().mockRejectedValue(new Error("rate limited"));
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "cat name", userId: "u1" });

		expect(variants).toEqual(["cat name"]);
	});

	it("returns only the original query when disabled", async () => {
		const complete = vi.fn().mockResolvedValue("Did I tell you about my cat?");
		const rewriter = createRewriter(complete, { disabled: true });
		const variants = await rewriter.rewrite({ query: "cat name", userId: "u1" });

		expect(variants).toEqual(["cat name"]);
		expect(complete).not.toHaveBeenCalled();
	});

	it("respects maxVariants", async () => {
		const complete = vi.fn().mockResolvedValue("Did I tell you the name of my cat?");
		const rewriter = createRewriter(complete, { maxVariants: 0 });
		const variants = await rewriter.rewrite({ query: "What is my cat's name?", userId: "u1" });

		expect(variants).toEqual(["What is my cat's name?"]);
	});

	it("returns up to maxVariants rewritten variants from a bullet list", async () => {
		const complete = vi
			.fn()
			.mockResolvedValue(
				"- Did I tell you the name of my cat?\n- What did I say my cat's name was?\n- Have I mentioned my cat?",
			);
		const rewriter = createRewriter(complete, { maxVariants: 3 });
		const variants = await rewriter.rewrite({ query: "What is my cat's name?", userId: "u1" });

		expect(variants).toEqual([
			"What is my cat's name?",
			"Did I tell you the name of my cat?",
			"What did I say my cat's name was?",
			"Have I mentioned my cat?",
		]);
	});

	it("dedups rewritten lines that are case-insensitive duplicates of the original", async () => {
		const complete = vi.fn().mockResolvedValue("- What is my cat's name?\n- Have I mentioned my cat?");
		const rewriter = createRewriter(complete, { maxVariants: 2 });
		const variants = await rewriter.rewrite({ query: "What is my cat's name?", userId: "u1" });

		expect(variants).toEqual(["What is my cat's name?", "Have I mentioned my cat?"]);
	});
	it("treats all-caps variants as duplicates of the original (case-insensitive safety net)", async () => {
		// LLMs occasionally normalise or shout the input. The dedup set
		// lowercases everything so we never emit a variant that just
		// echoes the original in a different register.
		const complete = vi.fn().mockResolvedValue("- WHAT IS MY CAT'S NAME?\n- Have I mentioned my cat?");
		const rewriter = createRewriter(complete, { maxVariants: 3 });
		const variants = await rewriter.rewrite({ query: "What is my cat's name?", userId: "u1" });

		expect(variants).toEqual(["What is my cat's name?", "Have I mentioned my cat?"]);
	});

	it("preserves the original casing of accepted variants", async () => {
		// The dedup set is case-insensitive, but the pushed value preserves
		// whatever casing the model emitted — only the comparison is
		// normalised.
		const complete = vi.fn().mockResolvedValue("- Did I tell you about My Cat?");
		const rewriter = createRewriter(complete);
		const variants = await rewriter.rewrite({ query: "what about my cat?", userId: "u1" });

		expect(variants).toEqual(["what about my cat?", "Did I tell you about My Cat?"]);
	});
});

describe("createIdentityRewriter", () => {
	it("always returns the original query", async () => {
		const rewriter = createIdentityRewriter();
		const variants = await rewriter.rewrite({ query: "anything", userId: "u1" });
		expect(variants).toEqual(["anything"]);
	});
});
