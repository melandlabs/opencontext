/**
 * `opencontext doctor` — vitest cases.
 *
 * Mirrors the `embedding-provider-export.test.ts` env-mutation pattern:
 * every test that mutates `process.env` snapshots the prior value once
 * at module load and restores it in a single shared `afterEach`. The
 * `clearEnvVar()` helper uses `delete` to truly remove a key because
 * Node's `process.env.X = undefined` coerces to the string `"undefined"`,
 * which differs in semantics (e.g. `key in process.env`) from a deleted key.
 *
 * No real filesystem side effects: the filesystem section is exercised
 * with an injected `homeDir` pointing at `/tmp/__doctor-test-home__`.
 * The loop / memory-store sections are not directly probed here
 * because `readPreferences()` and `createRawMessageStore()` both
 * touch `~/.opencontext/{loop,memory}/` as part of their happy path —
 * exercising them would require a fully-mocked filesystem layer, which
 * is overkill for a smoke test of the option parser + helpers.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
	type CheckResult,
	checkIntegrations,
	checkLoopCli,
	checkPolicies,
	checkRuntime,
	checkSecurity,
	parseDoctorArgs,
	renderHuman,
	renderJson,
	runDoctor,
} from "./doctor";

function clearEnvVar(key: string): void {
	// `process.env.X = undefined` coerces to the string "undefined" — only
	// `delete` truly removes the key, which the env-restoration pattern needs.
	delete process.env[key];
}

// Snapshot every env var this test file touches. Restore in one
// `afterEach` so biome's `noDuplicateTestHooks` rule stays happy.
const ENV_SNAPSHOT = {
	TG_APP_ID: process.env.TG_APP_ID,
	TG_APP_HASH: process.env.TG_APP_HASH,
	ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
	OPENCONTEXT_LOOP_CLI: process.env.OPENCONTEXT_LOOP_CLI,
	OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED: process.env.OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED,
	OPENCONTEXT_MEMORY_GRAPH_CORRECTION_ENABLED: process.env.OPENCONTEXT_MEMORY_GRAPH_CORRECTION_ENABLED,
} as const;

afterEach(() => {
	for (const [key, prev] of Object.entries(ENV_SNAPSHOT)) {
		if (prev === undefined) {
			clearEnvVar(key);
		} else {
			process.env[key] = prev;
		}
	}
});

describe("opencontext doctor", () => {
	// ── 1. runDoctor + json envelope ────────────────────────────────────────
	it("runDoctor returns a stable JSON-shaped result for --section runtime", async () => {
		const exit = await runDoctor({
			json: true,
			homeDir: "/tmp/__doctor-test-home__",
			section: "runtime",
		});
		expect(exit).toBe(0);
	});

	it("renderJson produces the documented envelope shape", () => {
		const results = [
			{ section: "runtime", name: "node-version", status: "ok" as const, detail: "v22.13.10" },
			{
				section: "loop",
				name: "loop-cli",
				status: "warn" as const,
				detail: "not found; set OPENCONTEXT_LOOP_CLI",
			},
		];
		const json = renderJson(results, 0);
		const parsed = JSON.parse(json) as {
			ok: boolean;
			exit: number;
			results: unknown[];
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.exit).toBe(0);
		expect(Array.isArray(parsed.results)).toBe(true);
		expect(parsed.results).toHaveLength(2);
	});

	it("renderHuman omits passing checks by default", () => {
		const results = [
			{ section: "runtime", name: "node-version", status: "ok" as const, detail: "v22.13.10" },
			{
				section: "security",
				name: "encryption-key",
				status: "warn" as const,
				detail: "ENCRYPTION_KEY not set",
			},
		];
		const human = renderHuman(results, false);
		expect(human).not.toContain("node-version");
		expect(human).toContain("encryption-key");
		expect(human).toContain("Summary:");
	});

	it("renderHuman prints passing checks when --verbose is set", () => {
		const results = [
			{ section: "runtime", name: "node-version", status: "ok" as const, detail: "v22.13.10" },
		];
		const human = renderHuman(results, true);
		expect(human).toContain("node-version");
		expect(human).toContain("Summary: 1 passed, 0 warn, 0 failed");
	});

	// ── 2-4. parseDoctorArgs ──────────────────────────────────────────────
	it("parseDoctorArgs populates --section", () => {
		expect(parseDoctorArgs(["--section", "memory-store"])).toEqual({
			section: "memory-store",
		});
	});

	it("parseDoctorArgs populates all four toggle flags", () => {
		expect(parseDoctorArgs(["--json", "--verbose", "--deep", "--user", "alice"])).toEqual({
			json: true,
			verbose: true,
			deep: true,
			userId: "alice",
		});
	});

	it("parseDoctorArgs throws on unknown flag", () => {
		expect(() => parseDoctorArgs(["--unknown-flag"])).toThrow(/unknown flag/);
	});

	// ── 5. checkRuntime ───────────────────────────────────────────────────
	it("checkRuntime returns >= 2 ok results (node-version + package-version)", async () => {
		const results = await checkRuntime({
			homeDir: "/tmp/__doctor-test-home__",
			userId: "__doctor__",
			deep: false,
		});
		expect(results.length).toBeGreaterThanOrEqual(2);
		for (const r of results) {
			expect(r.status).toBe("ok");
			expect(r.detail.length).toBeGreaterThan(0);
		}
	});

	// ── 6. checkIntegrations ──────────────────────────────────────────────
	it("checkIntegrations reports telegram creds as warn when TG_APP_ID unset", async () => {
		clearEnvVar("TG_APP_ID");
		clearEnvVar("TG_APP_HASH");
		const results = await checkIntegrations();
		const telegram = results.find((r: CheckResult) => r.name === "telegram-creds");
		expect(telegram).toBeDefined();
		expect(telegram?.status).toBe("warn");
	});

	// ── 7. checkSecurity ──────────────────────────────────────────────────
	it("checkSecurity reports missing ENCRYPTION_KEY as warn (not fail)", async () => {
		clearEnvVar("ENCRYPTION_KEY");
		const results = await checkSecurity();
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("warn");
		expect(results[0]?.detail).toContain("ENCRYPTION_KEY");
	});

	// ── 8. checkPolicies ──────────────────────────────────────────────────
	it("checkPolicies returns memory_graph_write_cohort_miss reason code for default probe id", async () => {
		// With the write flag enabled but no cohort allowlist, the policy
		// short-circuits on the "missed cohort" branch — the
		// `cohort_miss` reason is what surfaces to the user as a
		// deliberate, opt-in rejection.
		process.env.OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED = "true";
		const results = await checkPolicies({
			homeDir: "/tmp/__doctor-test-home__",
			userId: "__doctor__",
			deep: false,
		});
		const writePolicy = results.find((r: CheckResult) => r.name === "write-policy");
		expect(writePolicy).toBeDefined();
		expect(writePolicy?.detail).toContain("memory_graph_write_cohort_miss");
	});

	// ── 9. checkLoopCli ───────────────────────────────────────────────────
	it("checkLoopCli warns when loop-cli.mjs is missing in workspace/host-app context", () => {
		// Pin the env var to a non-existent path so a local loop-cli.mjs
		// never masks the missing-shim behavior in this test.
		process.env.OPENCONTEXT_LOOP_CLI = "/tmp/__doctor-test-loop-cli__.mjs";
		const result = checkLoopCli();
		expect(result.section).toBe("loop");
		expect(result.name).toBe("loop-cli");
		expect(result.status).toBe("warn");
		expect(result.detail).toContain("not found");
	});

	it("checkLoopCli returns ok for published npm bundle even when shim is missing", () => {
		process.env.OPENCONTEXT_LOOP_CLI = "/tmp/__doctor-test-loop-cli__.mjs";
		const npmUrl =
			"file:///Users/timi/.npm/_npx/abcd1234/node_modules/@melandlabs/opencontext/dist/cli/doctor.js";
		const result = checkLoopCli(npmUrl);
		expect(result.section).toBe("loop");
		expect(result.name).toBe("loop-cli");
		expect(result.status).toBe("ok");
		expect(result.detail).toContain("not bundled");
	});

	it("checkLoopCli recognizes pnpm nested layout as published bundle", () => {
		process.env.OPENCONTEXT_LOOP_CLI = "/tmp/__doctor-test-loop-cli__.mjs";
		const pnpmUrl =
			"file:///Users/timi/codes/some-project/node_modules/.pnpm/@melandlabs+opencontext@0.2.4/node_modules/@melandlabs/opencontext/dist/cli/doctor.js";
		const result = checkLoopCli(pnpmUrl);
		expect(result.status).toBe("ok");
	});

	it("checkLoopCli recognizes monorepo source as non-published context", () => {
		process.env.OPENCONTEXT_LOOP_CLI = "/tmp/__doctor-test-loop-cli__.mjs";
		const workspaceUrl = "file:///Users/timi/codes/opencontext/packages/opencontext/src/cli/doctor.ts";
		const result = checkLoopCli(workspaceUrl);
		expect(result.status).toBe("warn");
	});
});
