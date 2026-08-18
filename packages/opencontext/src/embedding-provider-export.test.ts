/**
 * @melandlabs/opencontext facade — cloud/local embedding provider re-exports.
 *
 * `@melandlabs/ai-rag` is an optional peer dep. This test pins that the
 * facade re-exports the provider symbols when the package is installed
 * (it is, in this workspace — see `devDependencies`), and that the
 * factory honours `EMBEDDING_PROVIDER=local`. Crucially, this test does
 * **not** call `embedQuery` / `embedDocuments` — those would trigger the
 * ONNX model load (network + ~30 MB download on first run). Routing
 * construction only, mirroring the opencontext unit test pattern.
 */

import { afterEach, describe, expect, it } from "vitest";

import * as facade from "./index";

describe("@melandlabs/opencontext facade — embedding provider re-exports", () => {
	const previousProvider = process.env.EMBEDDING_PROVIDER;

	afterEach(() => {
		if (previousProvider === undefined) {
			// biome-ignore lint/performance/noDelete: env-restoration pattern
			delete process.env.EMBEDDING_PROVIDER;
		} else {
			process.env.EMBEDDING_PROVIDER = previousProvider;
		}
	});

	it("re-exports LocalTransformersEmbeddingProvider as a constructable class", () => {
		expect(typeof facade.LocalTransformersEmbeddingProvider).toBe("function");
		const instance = new facade.LocalTransformersEmbeddingProvider({ modelName: "Xenova/all-MiniLM-L6-v2" });
		expect(instance.constructor.name).toBe("LocalTransformersEmbeddingProvider");
		expect(typeof instance.embedDocuments).toBe("function");
		expect(typeof instance.embedQuery).toBe("function");
		expect(instance.getModelName()).toBe("Xenova/all-MiniLM-L6-v2");
		// getDimensions() is undefined until the first embed completes — the
		// constructor must not load the model eagerly.
		expect(instance.getDimensions()).toBeUndefined();
	});

	it("re-exports the factory and provider-type helpers", () => {
		expect(typeof facade.getConfiguredEmbeddingProvider).toBe("function");
		expect(typeof facade.getConfiguredEmbeddingModelName).toBe("function");
		expect(typeof facade.getEmbeddingProviderType).toBe("function");
	});

	it("factory routes EMBEDDING_PROVIDER=local to LocalTransformersEmbeddingProvider", () => {
		process.env.EMBEDDING_PROVIDER = "local";
		const provider = facade.getConfiguredEmbeddingProvider();
		expect(provider.constructor.name).toBe("LocalTransformersEmbeddingProvider");
		expect(typeof provider.embedDocuments).toBe("function");
		expect(typeof provider.embedQuery).toBe("function");
		expect(typeof provider.getModelName).toBe("function");
	});

	it("factory defaults to cloud when EMBEDDING_PROVIDER is unset", () => {
		// biome-ignore lint/performance/noDelete: env-reset pattern
		delete process.env.EMBEDDING_PROVIDER;
		const provider = facade.getConfiguredEmbeddingProvider();
		expect(provider.constructor.name).toBe("CloudEmbeddingProvider");
	});

	it("factory exposes CloudEmbeddingProvider as a constructable class", () => {
		expect(typeof facade.CloudEmbeddingProvider).toBe("function");
		const instance = new facade.CloudEmbeddingProvider({ apiKey: "test-key" });
		expect(instance.constructor.name).toBe("CloudEmbeddingProvider");
		expect(typeof instance.embedDocuments).toBe("function");
	});

	it("re-exports the EmbeddingProvider type surface (interfaces compile-checked)", () => {
		// Type-only assertions — these resolve to compile-time checks via
		// the `.d.ts` files emitted by `@melandlabs/ai-rag`. If the
		// facade breaks the type bridge, tsc / dts emit would have
		// already failed at build time.
		const options: facade.LocalTransformersEmbeddingProviderOptions = {
			modelName: "Xenova/all-MiniLM-L6-v2",
		};
		const cloudOptions: facade.CloudEmbeddingProviderOptions = { apiKey: "k" };
		const _provider: facade.EmbeddingProvider = new facade.CloudEmbeddingProvider(cloudOptions);
		const _type: facade.EmbeddingProviderType = "local";
		const _factory: facade.EmbeddingProviderFactoryOptions = { local: options };
		expect(options.modelName).toBe("Xenova/all-MiniLM-L6-v2");
		expect(_type).toBe("local");
		expect(_factory.local?.modelName).toBe("Xenova/all-MiniLM-L6-v2");
	});
});
