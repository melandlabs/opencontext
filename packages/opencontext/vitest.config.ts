import { defineConfig } from "vitest/config";

/**
 * Tests for @melandlabs/opencontext live in src/index.test.ts (next to
 * the source). This config restricts vitest's file scan to the src tree
 * so LICENSE / dist / node_modules never get loaded.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
