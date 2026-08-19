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
		// The CodexAgent tests spawn a fake `codex` CLI (literally
		// `process.execPath` running a tiny node script) and immediately
		// `stdin.end()` the prompt. On macOS runners the child occasionally
		// isn't ready to read yet, which surfaces as `Failed to write Codex
		// prompt to stdin: write EPIPE` and trips the whole `pnpm -r test`
		// job. Retry once on darwin so a transient race doesn't block CI.
		retry: process.platform === "darwin" ? 1 : 0,
	},
});
