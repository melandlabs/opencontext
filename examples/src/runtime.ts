/**
 * Runtime + lifecycle packages.
 *
 * Covers @melandlabs/loop, @melandlabs/hooks, @melandlabs/ui-runtime,
 * @melandlabs/cron, and @melandlabs/env-config. These power the local app
 * shell, scheduled tasks, and React hooks. We only verify imports resolve
 * and key exports are well-shaped; we don't actually start timers or
 * mount React components in this smoke test.
 */

import * as loop from "@melandlabs/loop";
import * as hooks from "@melandlabs/hooks";
import * as uiRuntime from "@melandlabs/ui-runtime";
import * as cron from "@melandlabs/cron";
import * as envConfig from "@melandlabs/env-config";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testRuntime() {
	await runSection("@melandlabs/loop", async () => {
		const check = makeCheck("loop");
		check("readPreferences is a function", typeof loop.readPreferences === "function");
		check("writePreferences is a function", typeof loop.writePreferences === "function");
		const exported = Object.keys(loop).filter((k) => !k.startsWith("_"));
		check("loop exports additional symbols", exported.length >= 2);
	});

	await runSection("@melandlabs/hooks", async () => {
		const check = makeCheck("hooks");
		// Hooks are named `use*`. Count them as a sanity check.
		const hookNames = Object.keys(hooks).filter((k) => k.startsWith("use"));
		check("hooks module exports at least one use* function", hookNames.length >= 1);
		// Each use* export should be a function (the hook itself).
		check(
			"every use* export is a function",
			hookNames.every((n) => typeof (hooks as Record<string, unknown>)[n] === "function"),
		);
	});

	await runSection("@melandlabs/ui-runtime", async () => {
		const check = makeCheck("ui-runtime");
		const exported = Object.keys(uiRuntime).filter((k) => !k.startsWith("_"));
		check("ui-runtime exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/cron", async () => {
		const check = makeCheck("cron");
		const exported = Object.keys(cron).filter((k) => !k.startsWith("_"));
		check("cron exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/env-config", async () => {
		const check = makeCheck("env-config");
		// isDevelopmentEnvironment / isProductionEnvironment are precomputed
		// booleans derived from NODE_ENV, not functions.
		check("isDevelopmentEnvironment is exported", "isDevelopmentEnvironment" in envConfig);
		check("isProductionEnvironment is exported", "isProductionEnvironment" in envConfig);
		check("isDevelopmentEnvironment is a boolean", typeof envConfig.isDevelopmentEnvironment === "boolean");
		check("isProductionEnvironment is a boolean", typeof envConfig.isProductionEnvironment === "boolean");
		check("isServerMode is a function", typeof envConfig.isServerMode === "function");
		check("isTauriMode is a function", typeof envConfig.isTauriMode === "function");
	});
}
