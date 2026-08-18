import { defineConfig } from "vitest/config";

/**
 * Tests for @melandlabs/opencontext live in src/index.test.ts (next to
 * the source). This config restricts vitest's file scan to the src tree
 * so LICENSE / dist / node_modules never get loaded.
 *
 * Integration tests (`*.integration.test.ts`) are picked up by the
 * separate `vitest.integration.config.ts` and excluded here so the
 * default `pnpm test` run never hits the network.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["**/*.integration.test.ts", "node_modules", "dist"],
		environment: "node",
	},
});
