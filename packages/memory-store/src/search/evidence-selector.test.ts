import { describe, expect, it, vi } from "vitest";
import { createExtractiveEvidenceSelector } from "./evidence-selector";
import { presentMessageContext } from "./message-context";
import type { UnifiedMemorySearchResult } from "./utilities";

const hit = (
	id = "m1",
	content = "Background. 雪😀 I spent $75. Do not omit this qualification.",
): UnifiedMemorySearchResult => ({
	type: "memory",
	id,
	content,
	similarity: 0.9,
	metadata: {
		userId: "alice",
		messageSequence: 7,
		role: "user",
		matchedSpans: [
			{
				content,
				startPosition: 100,
				endPosition: 100 + content.length,
				channels: [{ name: "memory-bm25", rank: 1 }],
				sourceChunkIds: ["c1"],
			},
		],
	},
});
const response = (id: string, text: string, excerpt = 0) =>
	JSON.stringify({ selections: [{ id, quotes: [{ excerpt, text }] }] });

describe("extractive evidence selection", () => {
	it("preserves exact Unicode text, source offsets, rank, metadata and immutable original evidence", async () => {
		const original = hit();
		const snapshot = JSON.stringify(original);
		const quote = "雪😀 I spent $75. Do not omit this qualification.";
		const selector = createExtractiveEvidenceSelector({ complete: async () => response("m1", quote) });
		const { hits, warnings } = await selector.select({ query: "How much did I spend?", hits: [original] });
		expect(warnings).toEqual([]);
		expect(hits[0]).toMatchObject({
			id: "m1",
			similarity: 0.9,
			content: quote,
			metadata: { messageSequence: 7 },
		});
		expect(hits[0].metadata.matchedSpans).toMatchObject([
			{ startPosition: 112, endPosition: 100 + original.content.length, sourceChunkIds: ["c1"] },
		]);
		expect(hits[0].metadata.contextSelection).toMatchObject({
			status: "selected",
			originalSpans: original.metadata.matchedSpans,
		});
		expect(JSON.stringify(original)).toBe(snapshot);
		expect(presentMessageContext(hits)[0].content).toContain(quote);
		expect(presentMessageContext(hits)[0].content).not.toContain("Background.");
	});

	it.each(["I spent $750.", "missing original text", ""])(
		"rejects invented or empty text: %s",
		async (quote) => {
			const original = hit();
			const result = await createExtractiveEvidenceSelector({
				complete: async () => response("m1", quote),
			}).select({ query: "cost?", hits: [original] });
			expect(result.hits[0].content).toBe(original.content);
			expect(result.warnings[0].code).toBe("evidence_selection_fallback");
		},
	);

	it.each(["unknown", "duplicate", "malformed", "transport", "bad-index", "ambiguous"])(
		"fails safely for %s",
		async (failure) => {
			const original = hit("m1", "repeat repeat");
			const complete = async () => {
				if (failure === "transport") throw new Error("private error details");
				if (failure === "unknown") return response("foreign-user", "repeat");
				if (failure === "duplicate")
					return JSON.stringify({
						selections: [
							{ id: "m1", quotes: [] },
							{ id: "m1", quotes: [] },
						],
					});
				if (failure === "bad-index") return response("m1", "repeat", -1);
				if (failure === "ambiguous") return response("m1", "repeat");
				return "not JSON";
			};
			const result = await createExtractiveEvidenceSelector({ complete }).select({
				query: "topic",
				hits: [original],
			});
			expect(result.hits[0].content).toBe(original.content);
			expect(JSON.stringify(result)).not.toContain("private error details");
			expect(result.warnings).toHaveLength(1);
		},
	);

	it("does not replace another source type with the same ID or invent timestamps", async () => {
		const original = hit();
		const knowledge = { ...hit(), type: "knowledge" as const, content: "document" };
		const { hits } = await createExtractiveEvidenceSelector({
			complete: async () => response("m1", "I spent $75."),
		}).select({ query: "cost?", hits: [knowledge, original] });
		expect(hits[0]).toBe(knowledge);
		expect(hits[1].metadata.timestamp).toBeUndefined();
	});

	it("keeps missing or explicitly unselected sources intact, including their order", async () => {
		const originals = [hit("a"), hit("b")];
		const { hits } = await createExtractiveEvidenceSelector({
			complete: async () => '{"selections":[{"id":"a","quotes":[]}]}',
		}).select({ query: "topic", hits: originals });
		expect(hits.map((item) => item.id)).toEqual(["a", "b"]);
		expect(hits.map((item) => item.content)).toEqual(originals.map((item) => item.content));
	});

	it("does not silently truncate oversized sources and bounds batch source characters", async () => {
		const complete = vi.fn(async (_prompt: string) => '{"selections":[]}');
		const originals = [
			hit("oversized", "x".repeat(1100)),
			hit("small", "y".repeat(500)),
			hit("other", "z".repeat(500)),
		];
		const { hits, warnings } = await createExtractiveEvidenceSelector({
			complete,
			maxSourceCharacters: 1000,
		}).select({ query: "topic", hits: originals });
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [prompt] of complete.mock.calls)
			expect(prompt.split("HISTORICAL SOURCES:\n")[1].length).toBeLessThanOrEqual(1000);
		expect(hits.map((item) => item.content)).toEqual(originals.map((item) => item.content));
		expect(warnings[0].message).toBe("source_exceeds_request_budget");
	});
});
