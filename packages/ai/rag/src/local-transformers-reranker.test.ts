import { describe, expect, it, vi } from "vitest";
import { LocalTransformersReranker } from "./local-transformers-reranker";

function runtimeWithScores(scoresByContent: Record<string, number>) {
	const tokenizer = vi.fn((queries: string[], options: { text_pair: string[] }) => ({
		queries,
		contents: options.text_pair,
	}));
	const model = vi.fn(async (input: { contents: string[] }) => ({
		logits: {
			data: Float32Array.from(input.contents.map((content) => scoresByContent[content] ?? 0)),
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
		const tokenizer = (queries: string[], options: { text_pair: string[] }) => ({
			queries,
			contents: options.text_pair,
		});
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
