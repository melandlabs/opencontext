import { defineConfig } from "vitest/config";

/**
 * Vitest config that picks up only `*.integration.test.ts` files for the
 * opencontext facade. Mirrors `@melandlabs/memory-store`'s setup. These
 * tests talk to a real LLM (via `OPENCONTEXT_LLM_*` env vars) and are
 * skipped automatically when the credentials aren't present or the
 * endpoint isn't reachable, so CI without secrets won't fail.
 *
 * Run with:
 *   pnpm --filter @melandlabs/opencontext test:integration
 */
export default defineConfig({
	test: {
		include: ["src/**/*.integration.test.ts"],
		exclude: ["node_modules", "dist"],
		environment: "node",
		// Real LLM calls regularly take 5-30s; the default 5s timeout
		// would flake every green run. Individual tests still declare a
		// per-test timeout in their `it()` for tighter budgets.
		testTimeout: 60_000,
		// Run sequentially so two integration tests don't share a single
		// rate-limited endpoint.
		fileParallelism: false,
	},
});
