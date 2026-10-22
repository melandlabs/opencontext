import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// `test/postgres-store.test.ts` talks to a real database, which
		// may be a hosted one: a test is a handful of round trips, and the
		// first connection of a run pays for DNS, the TLS handshake and the
		// server's own startup. The 5s and 10s defaults are not enough for
		// that, and a hook that times out takes the whole file down with
		// it — reported as a skip, which reads like a suite that never
		// ran.
		testTimeout: 60_000,
		hookTimeout: 120_000,
	},
});
