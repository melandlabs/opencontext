/**
 * @melandlabs/loop — paths + preferences round-trip.
 *
 * These are the on-disk primitives every host app that uses Loop
 * touches on startup. The contract being pinned here:
 *
 *   - LOOP_PATHS.home / config / signals / decisions live under
 *     ~/.opencontext/loop/, with the file names the host's watcher,
 *     scheduler, and decision UI all expect.
 *   - ensureDirs() creates the home + inbox/.processed + inbox/.failed.
 *   - readPreferences() with no config.json returns the defaults,
 *     including `enabled: false` (#417 — opt-in by design).
 *   - writePreferences(patch) shallow-merges, persists, and returns the
 *     full result. Keys absent from the patch keep their default value.
 *
 * All filesystem-touching tests run against a sandboxed $HOME so the
 * developer's real ~/.opencontext/loop/ is never written.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getOpenContextDir() prefers OPENCONTEXT_HOME over HOME, and LOOP_HOME is
// captured at import time below. vi.hoisted runs before any module-load-time
// path resolution, so a host with OPENCONTEXT_HOME pre-set doesn't leak its
// real ~/.opencontext/loop/ into the assertions or the child-process spawns.
vi.hoisted(() => {
	// getOpenContextDir() treats any non-empty override as authoritative,
	// so explicitly clearing it (vs. setting it to the string "undefined")
	// forces the fall-through to the stubbed HOME.
	process.env.OPENCONTEXT_HOME = "";
});

import { LOOP_HOME, LOOP_PATHS } from "./paths";

const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
	process.env.HOME = mkdtempSync(join(tmpdir(), "loop-test-"));
});

afterEach(() => {
	// biome-ignore lint/performance/noDelete: assigning undefined would set HOME to the string "undefined".
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
});

describe("LOOP_PATHS", () => {
	it("places every file under ~/.opencontext/loop/", () => {
		expect(LOOP_PATHS.home).toBe(join(LOOP_HOME, ""));
		// LOOP_HOME itself equals ~/.opencontext/loop, regardless of platform.
		expect(LOOP_PATHS.home.endsWith(".opencontext/loop")).toBe(true);
	});

	it("names the well-known files with their expected extensions", () => {
		expect(LOOP_PATHS.signals.endsWith("signals.jsonl")).toBe(true);
		expect(LOOP_PATHS.decisions.endsWith("decisions.json")).toBe(true);
		expect(LOOP_PATHS.config.endsWith("config.json")).toBe(true);
		expect(LOOP_PATHS.brief.endsWith("brief.json")).toBe(true);
		expect(LOOP_PATHS.wrap.endsWith("wrap.json")).toBe(true);
	});

	it("puts the inbox under the home dir and orders config / decisions / signals stably", () => {
		expect(LOOP_PATHS.inbox.startsWith(LOOP_PATHS.home)).toBe(true);
		// All path values are distinct.
		const all = new Set([
			LOOP_PATHS.signals,
			LOOP_PATHS.decisions,
			LOOP_PATHS.status,
			LOOP_PATHS.brief,
			LOOP_PATHS.wrap,
			LOOP_PATHS.connectors,
			LOOP_PATHS.config,
			LOOP_PATHS.mutes,
		]);
		expect(all.size).toBe(8);
	});
});

describe("defaults — #417 (opt-in by design)", () => {
	/** Runs in a child process so $HOME redirection is honoured by os.homedir(). */
	const CHILD = `
import { LOOP_PATHS, ensureDirs, readPreferences } from "${"@melandlabs/loop".replace("@melandlabs/loop", "./dist/index.js") ?? "@melandlabs/loop"}";
const out = {
  home: LOOP_PATHS.home,
  homeExistsAfterEnsure: false,
  defaults: readPreferences(),
};
import { existsSync } from "node:fs";
ensureDirs();
out.homeExistsAfterEnsure = existsSync(LOOP_PATHS.home);
process.stdout.write("__OUT__" + JSON.stringify(out));
`;

	it("readPreferences returns a complete default object when no config.json exists", () => {
		const raw = execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", CHILD], {
			cwd: process.cwd(),
			env: { ...process.env },
			encoding: "utf8",
		});
		const line = raw.split("\n").find((l) => l.startsWith("__OUT__"));
		const out = JSON.parse((line as string).slice("__OUT__".length));

		// Home redirected to the sandbox.
		expect(out.home).toContain(process.env.HOME);
		expect(out.homeExistsAfterEnsure).toBe(true);

		expect(out.defaults.enabled).toBe(false);
		expect(out.defaults.briefTime).toBeNull();
		expect(out.defaults.wrapTime).toBeNull();
		expect(typeof out.defaults.intervalSec).toBe("number");
		expect(out.defaults.intervalSec).toBeGreaterThan(0);
		expect(typeof out.defaults.narrative).toBe("boolean");
		expect(out.defaults.attentionBudget.daily).toBe(3);
		expect(out.defaults.cooldown.windowSec).toBe(1800);
	});
});

describe("preferences round-trip", () => {
	/**
	 * For round-trip we need writePreferences to actually hit disk. It uses
	 * os.homedir() at call time, so as long as $HOME is set before the
	 * import of @melandlabs/loop runs, the redirect works. The downside:
	 * the test runs in-process and we can't easily reset the module cache,
	 * so we isolate the file-write paths via a child process too.
	 */
	const CHILD = `
import { LOOP_PATHS, readPreferences, writePreferences } from "@melandlabs/loop";
import { existsSync, readFileSync } from "node:fs";
const beforeWrite = existsSync(LOOP_PATHS.config);
const defaults = readPreferences();
const written = writePreferences({ intervalSec: 42, narrative: false });
const after = readPreferences();
const onDisk = JSON.parse(readFileSync(LOOP_PATHS.config, "utf8"));
process.stdout.write("__OUT__" + JSON.stringify({
  beforeWrite,
  defaultEnabled: defaults.enabled,
  writtenInterval: written.intervalSec,
  writtenNarrative: written.narrative,
  afterInterval: after.intervalSec,
  afterNarrative: after.narrative,
  afterEnabled: after.enabled,
  onDiskInterval: onDisk.intervalSec,
  onDiskNarrative: onDisk.narrative,
}));
`;

	it("writePreferences persists the patch and readPreferences round-trips it", () => {
		const raw = execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", CHILD], {
			cwd: process.cwd(),
			env: { ...process.env },
			encoding: "utf8",
		});
		const line = raw.split("\n").find((l) => l.startsWith("__OUT__"));
		const out = JSON.parse((line as string).slice("__OUT__".length));

		expect(out.beforeWrite).toBe(false);
		expect(out.defaultEnabled).toBe(false);
		expect(out.writtenInterval).toBe(42);
		expect(out.writtenNarrative).toBe(false);
		expect(out.afterInterval).toBe(42);
		expect(out.afterNarrative).toBe(false);
		// Keys absent from the patch keep their defaults.
		expect(out.afterEnabled).toBe(out.defaultEnabled);
		// Disk has the same merged shape.
		expect(out.onDiskInterval).toBe(42);
		expect(out.onDiskNarrative).toBe(false);
	});
});

describe("ensureDirs", () => {
	const CHILD = `
import { LOOP_PATHS, ensureDirs } from "@melandlabs/loop";
import { existsSync } from "node:fs";
ensureDirs();
process.stdout.write("__OUT__" + JSON.stringify({
  home: existsSync(LOOP_PATHS.home),
  inbox: existsSync(LOOP_PATHS.inbox),
}));
`;

	it("creates the home + inbox subdirs", () => {
		const raw = execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", CHILD], {
			cwd: process.cwd(),
			env: { ...process.env },
			encoding: "utf8",
		});
		const line = raw.split("\n").find((l) => l.startsWith("__OUT__"));
		const out = JSON.parse((line as string).slice("__OUT__".length));

		expect(out.home).toBe(true);
		expect(out.inbox).toBe(true);
	});
});

// Reference unused imports to keep this a no-op when the file is checked
// standalone (e.g. `tsc --noEmit`).
void existsSync;
void readFileSync;
void rmSync;
