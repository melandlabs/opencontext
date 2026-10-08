import { describe, expect, it, vi } from "vitest";
import { LocalTransformersReranker } from "./local-transformers-reranker";

const encode = (text: string, options: { text_pair?: string; add_special_tokens: boolean }): number[] =>
	Array.from(
		{
			length:
				Array.from(text).length +
				Array.from(options.text_pair ?? "").length +
				(options.add_special_tokens ? (options.text_pair === undefined ? 2 : 3) : 0),
		},
		() => 1,
	);

function runtimeWithScores(scoresByContent: Record<string, number> | ((content: string) => number)) {
	const tokenizer = Object.assign(
		vi.fn((queries: string[], options: { text_pair: string[] }) => ({
			queries,
			contents: options.text_pair,
		})),
		{ encode },
	);
	const model = vi.fn(async (input: { contents: string[] }) => ({
		logits: {
			data: Float32Array.from(
				input.contents.map((content) =>
					typeof scoresByContent === "function" ? scoresByContent(content) : (scoresByContent[content] ?? 0),
				),
			),
			dims: [input.contents.length, 1],
		},
	}));
	const runtimeLoader = vi.fn(async () => ({
		env: { cacheDir: "", remoteHost: "" },
		AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
		AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
	}));
	return { runtimeLoader, tokenizer, model };
}

describe("LocalTransformersReranker", () => {
	it("scores distinct matched chunks, max-pools by parent, and leaves expanded windows out of scoring", async () => {
		const runtime = runtimeWithScores({ weak: -2, strong: 4, medium: 1 });
		const reranker = new LocalTransformersReranker({
			runtimeLoader: runtime.runtimeLoader,
			candidateMode: "matched-chunks",
		});
		const result = await reranker.rerank({
			query: "query",
			candidates: [
				{
					id: "parent",
					content: "expanded irrelevant neighbors",
					metadata: {
						matchedSpans: [
							{ matchedContent: "weak", sourceChunkId: "c1", matchedStartPosition: 0 },
							{ matchedContent: "strong", sourceChunkId: "c2", matchedStartPosition: 100 },
							{ matchedContent: "strong", sourceChunkId: "c2", matchedStartPosition: 100 },
						],
					},
				},
				{ id: "other", content: "medium" },
			],
		});
		expect(result.map((row) => row.id)).toEqual(["parent", "other"]);
		expect(result[0].score).toBe(4);
		expect(result[0].evidenceScores).toHaveLength(2);
		expect(result[0].evidenceScores?.[1]).toMatchObject({
			sourceChunkId: "c2",
			startPosition: 100,
			endPosition: 106,
		});
		expect(runtime.model.mock.calls[0][0].contents).toEqual(["weak", "strong", "medium"]);
		expect(runtime.tokenizer).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ truncation: false }),
		);
	});

	it("preserves the end of oversized evidence through verified pair windows instead of silent tokenizer truncation", async () => {
		const runtime = runtimeWithScores((content) => (content.includes("ANSWER") ? 5 : 0));
		const reranker = new LocalTransformersReranker({
			runtimeLoader: runtime.runtimeLoader,
			candidateMode: "matched-chunks",
		});
		const result = await reranker.rerank({
			query: "question ".repeat(40),
			candidates: [
				{
					id: "parent",
					content: "not the scoring text",
					metadata: {
						matchedSpans: [
							{
								matchedContent: `${"a".repeat(1200)}ANSWER`,
								sourceChunkId: "long",
								matchedStartPosition: 100,
							},
						],
					},
				},
			],
		});
		expect(result[0].score).toBe(5);
		expect(result[0].evidenceScores?.length).toBeGreaterThan(1);
		for (const evidence of result[0].evidenceScores ?? []) {
			expect(evidence.inputTokens).toBeLessThanOrEqual(512);
			expect(evidence.queryTruncated).toBe(true);
		}
		expect(Math.max(...(result[0].evidenceScores ?? []).map((row) => row.endPosition ?? 0))).toBe(1306);
	});
	it("scores query/document pairs in batches and returns relevance order", async () => {
		const runtime = runtimeWithScores({ weak: -2, strong: 4, medium: 1 });
		const reranker = new LocalTransformersReranker({
			batchSize: 2,
			runtimeLoader: runtime.runtimeLoader,
		});

		const result = await reranker.rerank({
			query: "query",
			candidates: [
				{ id: "weak", content: "weak" },
				{ id: "strong", content: "strong" },
				{ id: "medium", content: "medium" },
			],
		});

		expect(result.map((item) => item.id)).toEqual(["strong", "medium", "weak"]);
		expect(runtime.model).toHaveBeenCalledTimes(2);
		expect(runtime.tokenizer).toHaveBeenCalledWith(
			["query", "query"],
			expect.objectContaining({ text_pair: ["weak", "strong"], truncation: true }),
		);
	});

	it("uses the positive logit and preserves original order for score ties", async () => {
		const tokenizer = Object.assign(
			(queries: string[], options: { text_pair: string[] }) => ({
				queries,
				contents: options.text_pair,
			}),
			{ encode },
		);
		const runtimeLoader = async () => ({
			env: { cacheDir: "", remoteHost: "" },
			AutoTokenizer: { from_pretrained: async () => tokenizer },
			AutoModelForSequenceClassification: {
				from_pretrained: async () => async () => ({
					logits: { data: Float32Array.from([-5, 2, -3, 2]), dims: [2, 2] },
				}),
			},
		});
		const reranker = new LocalTransformersReranker({ runtimeLoader });

		const result = await reranker.rerank({
			query: "q",
			candidates: [
				{ id: "first", content: "a" },
				{ id: "second", content: "b" },
			],
			topK: 1,
		});

		expect(result).toEqual([{ id: "first", score: 2 }]);
	});
});
