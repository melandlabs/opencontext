import { defineConfig } from "vitest/config";

/**
 * Tests for @melandlabs/ai live next to the source under src/ ... test.ts.
 * This config restricts vitest's scan to the src tree so dist / node_modules
 * are never loaded as test candidates.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		hookTimeout: 20000,
		testTimeout: 20000,
	},
});
