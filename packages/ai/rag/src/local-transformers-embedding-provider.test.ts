import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalTransformersEmbeddingProvider } from "./local-transformers-embedding-provider";

describe("LocalTransformersEmbeddingProvider", () => {
	const previousCacheDir = process.env.LOCAL_EMBEDDING_CACHE_DIR;
	const previousModel = process.env.LOCAL_EMBEDDING_MODEL;

	afterEach(() => {
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
});
