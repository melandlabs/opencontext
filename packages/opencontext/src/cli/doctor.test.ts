/**
 * `opencontext doctor` — vitest cases.
 *
 * Mirrors the `embedding-provider-export.test.ts` env-mutation pattern:
 * every test that mutates `process.env` snapshots the prior value in
 * `previousX` and restores it in `afterEach`, so a failed assertion
 * never leaks env mutations into the next case.
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
	type DoctorContext,
	checkIntegrations,
	checkPolicies,
	checkRuntime,
	checkSecurity,
	parseDoctorArgs,
	renderHuman,
	renderJson,
	runDoctor,
} from "./doctor";

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
			{ section: "loop", name: "loop-cli", status: "warn" as const, detail: "not found; set OPENCONTEXT_LOOP_CLI" },
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
			{ section: "security", name: "encryption-key", status: "warn" as const, detail: "ENCRYPTION_KEY not set" },
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
	const previousTgId = process.env.TG_APP_ID;
	const previousTgHash = process.env.TG_APP_HASH;

	afterEach(() => {
		if (previousTgId === undefined) delete process.env.TG_APP_ID;
		else process.env.TG_APP_ID = previousTgId;
		if (previousTgHash === undefined) delete process.env.TG_APP_HASH;
		else process.env.TG_APP_HASH = previousTgHash;
	});

	it("checkIntegrations reports telegram creds as warn when TG_APP_ID unset", async () => {
		delete process.env.TG_APP_ID;
		delete process.env.TG_APP_HASH;
		const results = await checkIntegrations();
		const telegram = results.find((r: CheckResult) => r.name === "telegram-creds");
		expect(telegram).toBeDefined();
		expect(telegram?.status).toBe("warn");
	});

	// ── 7. checkSecurity ──────────────────────────────────────────────────
	const previousEncKey = process.env.ENCRYPTION_KEY;

	afterEach(() => {
		if (previousEncKey === undefined) delete process.env.ENCRYPTION_KEY;
		else process.env.ENCRYPTION_KEY = previousEncKey;
	});

	it("checkSecurity reports missing ENCRYPTION_KEY as warn (not fail)", async () => {
		delete process.env.ENCRYPTION_KEY;
		const results = await checkSecurity();
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("warn");
		expect(results[0]?.detail).toContain("ENCRYPTION_KEY");
	});

	// ── 8. checkPolicies ──────────────────────────────────────────────────
	const previousWriteEnabled = process.env.OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED;
	const previousCorrectionEnabled = process.env.OPENCONTEXT_MEMORY_GRAPH_CORRECTION_ENABLED;

	afterEach(() => {
		if (previousWriteEnabled === undefined) delete process.env.OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED;
		else process.env.OPENCONTEXT_MEMORY_GRAPH_WRITE_ENABLED = previousWriteEnabled;
		if (previousCorrectionEnabled === undefined) delete process.env.OPENCONTEXT_MEMORY_GRAPH_CORRECTION_ENABLED;
		else process.env.OPENCONTEXT_MEMORY_GRAPH_CORRECTION_ENABLED = previousCorrectionEnabled;
	});

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
});
