import { defineConfig } from "vitest/config";

/**
 * Tests for @melandlabs/ai-rag live next to the source in src/. This
 * config restricts vitest's file scan so dist / node_modules are ignored.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
