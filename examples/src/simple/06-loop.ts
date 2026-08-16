/**
 * demo: @melandlabs/loop — on-disk user preferences.
 *
 * Loop keeps its state in a plain directory of JSON files under
 * `~/.opencontext/loop/`. `readPreferences()` shallow-merges the
 * persisted `config.json` on top of the built-in defaults, which is how
 * new preference keys get added without migrating existing installs.
 * `writePreferences(patch)` merges a partial patch and returns the full
 * resulting object.
 *
 * IMPORTANT for this demo: `LOOP_HOME` is computed from `os.homedir()`
 * once, at module load, and there is no override hook. Even
 * `readPreferences()` has a side effect — it calls `ensureDirs()`, which
 * creates `~/.opencontext/loop/`. Running that in-process would touch
 * the real home directory of whoever runs `pnpm test`.
 *
 * So every call that touches the filesystem happens in a child process
 * whose `$HOME` points at a throwaway directory (Node's `os.homedir()`
 * honours `$HOME` on POSIX). The demo still exercises the real API; it
 * just does so against a sandboxed home. In your own app you call these
 * functions directly.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { LOOP_PATHS } from "@melandlabs/loop";
import { info, makeCheck, runSection, withTmp } from "../_helpers.ts";

/** Runs in a child process whose $HOME is a scratch directory. */
const CHILD = `
import { LOOP_PATHS, ensureDirs, readPreferences, writePreferences } from "@melandlabs/loop";
import { existsSync, readFileSync } from "node:fs";

ensureDirs();

// No config.json yet — this returns the built-in defaults.
const defaults = readPreferences();
const hadConfigBefore = existsSync(LOOP_PATHS.config);

const written = writePreferences({ intervalSec: 42, narrative: false });
const after = readPreferences();

console.log("__DEMO__" + JSON.stringify({
  home: LOOP_PATHS.home,
  homeExists: existsSync(LOOP_PATHS.home),
  hadConfigBefore,
  configExists: existsSync(LOOP_PATHS.config),
  onDisk: JSON.parse(readFileSync(LOOP_PATHS.config, "utf8")),
  defaultKeys: Object.keys(defaults).sort(),
  defaultEnabled: defaults.enabled,
  defaultInterval: defaults.intervalSec,
  writtenInterval: written.intervalSec,
  afterInterval: after.intervalSec,
  afterNarrative: after.narrative,
  afterEnabled: after.enabled,
}));
`;

export default async function demoLoop() {
	await runSection("demo: @melandlabs/loop", async () => {
		const check = makeCheck("demo/loop");

		// LOOP_PATHS is a pure constant — reading it touches nothing.
		info("demo/loop", `real LOOP_HOME on this machine: ${LOOP_PATHS.home}`);
		check(
			"LOOP_PATHS places config.json inside LOOP_HOME",
			LOOP_PATHS.config === path.join(LOOP_PATHS.home, "config.json"),
			LOOP_PATHS.config,
		);
		check(
			"LOOP_PATHS also names the signal log and decisions file",
			LOOP_PATHS.signals.endsWith("signals.jsonl") && LOOP_PATHS.decisions.endsWith("decisions.json"),
		);

		// Everything that touches disk runs against a sandboxed $HOME.
		await withTmp("loop-home", async (dir) => {
			const raw = execFileSync(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", CHILD],
				{
					cwd: process.cwd(),
					env: { ...process.env, HOME: dir },
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const line = raw.split("\n").find((l) => l.startsWith("__DEMO__"));
			const out = JSON.parse((line as string).slice("__DEMO__".length));

			info("demo/loop", `child LOOP_HOME redirected to ${out.home}`);
			info("demo/loop", `defaults: enabled=${out.defaultEnabled}, intervalSec=${out.defaultInterval}`);
			info(
				"demo/loop",
				`after writePreferences: intervalSec=${out.afterInterval}, narrative=${out.afterNarrative}`,
			);

			check("the child's LOOP_HOME really moved into the scratch dir", out.home.startsWith(dir), out.home);
			check("ensureDirs() created LOOP_HOME", out.homeExists === true);
			check("readPreferences works before any config.json exists", out.hadConfigBefore === false);
			check(
				"those defaults are a full preferences object",
				out.defaultKeys.length >= 10,
				`${out.defaultKeys.length} keys`,
			);
			check("Loop is off by default — fresh installs must opt in", out.defaultEnabled === false);

			check("writePreferences created config.json on disk", out.configExists === true);
			check("writePreferences returns the merged result", out.writtenInterval === 42);
			check("readPreferences round-trips the patched intervalSec", out.afterInterval === 42);
			check("readPreferences round-trips the patched narrative flag", out.afterNarrative === false);
			check(
				"keys absent from the patch keep their default value",
				out.afterEnabled === out.defaultEnabled,
				`enabled=${out.afterEnabled}`,
			);
			check(
				"the patch was persisted as real JSON, not merely returned",
				out.onDisk.intervalSec === 42 && out.onDisk.narrative === false,
			);
		});
	});
}
