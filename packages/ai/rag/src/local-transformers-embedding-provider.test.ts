import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalTransformersEmbeddingProvider } from "./local-transformers-embedding-provider";

const { pipeline, fromPretrained } = vi.hoisted(() => ({ pipeline: vi.fn(), fromPretrained: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({
	env: { cacheDir: "", remoteHost: "" },
	pipeline,
	AutoTokenizer: { from_pretrained: fromPretrained },
}));

describe("LocalTransformersEmbeddingProvider", () => {
	const previousCacheDir = process.env.LOCAL_EMBEDDING_CACHE_DIR;
	const previousModel = process.env.LOCAL_EMBEDDING_MODEL;

	afterEach(() => {
		pipeline.mockReset();
		fromPretrained.mockReset();
		if (previousCacheDir === undefined) {
			// biome-ignore lint/performance/noDelete: env-restoration pattern
			delete process.env.LOCAL_EMBEDDING_CACHE_DIR;
		} else {
			process.env.LOCAL_EMBEDDING_CACHE_DIR = previousCacheDir;
		}

		if (previousModel === undefined) {
			// biome-ignore lint/performance/noDelete: env-restoration pattern
			delete process.env.LOCAL_EMBEDDING_MODEL;
		} else {
			process.env.LOCAL_EMBEDDING_MODEL = previousModel;
		}
	});

	it("defaults cacheDir to a stable directory under the user's home", () => {
		// biome-ignore lint/performance/noDelete: env-reset pattern
		delete process.env.LOCAL_EMBEDDING_CACHE_DIR;
		const provider = new LocalTransformersEmbeddingProvider();
		expect(provider.getCacheDir()).toBe(path.join(os.homedir(), ".cache", "opencontext", "local-embeddings"));
	});

	it("uses LOCAL_EMBEDDING_CACHE_DIR from the environment", () => {
		process.env.LOCAL_EMBEDDING_CACHE_DIR = "/tmp/custom-embedding-cache";
		const provider = new LocalTransformersEmbeddingProvider();
		expect(provider.getCacheDir()).toBe("/tmp/custom-embedding-cache");
	});

	it("options.cacheDir overrides the environment variable", () => {
		process.env.LOCAL_EMBEDDING_CACHE_DIR = "/tmp/env-cache";
		const provider = new LocalTransformersEmbeddingProvider({ cacheDir: "/tmp/opt-cache" });
		expect(provider.getCacheDir()).toBe("/tmp/opt-cache");
	});

	it("keeps the configured model name", () => {
		process.env.LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
		const provider = new LocalTransformersEmbeddingProvider();
		expect(provider.getModelName()).toBe("Xenova/all-MiniLM-L6-v2");
	});

	it("counts real content tokens without truncation, special tokens, or loading weights", async () => {
		const encode = vi.fn((text: string) => Array.from(text).map(() => 1));
		fromPretrained.mockResolvedValue({ encode });
		const provider = new LocalTransformersEmbeddingProvider({
			modelName: "test-model",
			localFilesOnly: true,
		});
		const counter = await provider.getTokenCounter();
		expect(counter("x".repeat(800))).toBe(800);
		expect(encode).toHaveBeenCalledWith("x".repeat(800), { add_special_tokens: false });
		expect(await provider.getTokenCounter()).toBe(counter);
		expect(fromPretrained).toHaveBeenCalledTimes(1);
		expect(pipeline).not.toHaveBeenCalled();
	});

	it("passes explicit ONNX adapter options without changing the default session", async () => {
		pipeline.mockResolvedValue(async () => ({ tolist: () => [[1, 0]] }));
		const sessionOptions = {
			executionProviders: [{ name: "dml", deviceId: 1 }],
			enableMemPattern: false,
			executionMode: "sequential",
		};
		await new LocalTransformersEmbeddingProvider({ device: "dml", sessionOptions }).embedQuery("test");
		expect(pipeline.mock.calls[0][2]).toMatchObject({ device: "dml", session_options: sessionOptions });
		await new LocalTransformersEmbeddingProvider().embedQuery("test");
		expect(pipeline.mock.calls[1][2]).not.toHaveProperty("session_options");
	});

	it("reduces padding by actual token length while restoring vector order", async () => {
		fromPretrained.mockResolvedValue({ encode: (text: string) => new Array(text.length) });
		const extractor = vi.fn(async (texts: string[]) => ({
			tolist: () => texts.map((text) => [text.length, 0]),
		}));
		pipeline.mockResolvedValue(extractor);
		const provider = new LocalTransformersEmbeddingProvider({ batchSize: 2, lengthAwareBatching: true });
		expect(await provider.embedDocuments(["long", "a", "xx", "b"])).toEqual([
			[4, 0],
			[1, 0],
			[2, 0],
			[1, 0],
		]);
		expect(extractor.mock.calls.map(([texts]) => texts)).toEqual([
			["a", "b"],
			["xx", "long"],
		]);
	});

	it("preserves ordinary batching without requiring a separate token counter", async () => {
		const extractor = vi.fn(async (texts: string[]) => ({
			tolist: () => texts.map((text) => [text.length, 0]),
		}));
		pipeline.mockResolvedValue(extractor);
		await new LocalTransformersEmbeddingProvider({ batchSize: 2 }).embedDocuments(["long", "a", "xx"]);
		expect(extractor.mock.calls.map(([texts]) => texts)).toEqual([["long", "a"], ["xx"]]);
		expect(fromPretrained).not.toHaveBeenCalled();
	});
});
