import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["**/*.integration.test.ts", "node_modules", "dist"],
		environment: "node",
		// The e2e semantic-search tests instantiate
		// `LocalTransformersEmbeddingProvider`, which on a cold cache downloads
		// the ONNX weights (~25 MB) on first call. CI runners are slower than
		// local dev machines and the default 5 s timeout races the download;
		// bump it so a cold Node 22 / 24 / 26 runner doesn't intermittently
		// fail with `Test timed out in 5000ms`.
		testTimeout: 60_000,
	},
});
