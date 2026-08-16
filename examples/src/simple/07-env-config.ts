/**
 * demo: @melandlabs/env-config — deployment mode detection.
 *
 * The same codebase ships as a Tauri desktop app and as a server, so
 * almost every host-dependent decision (where the database lives, which
 * paths are writable) routes through this package.
 *
 * Note the shape difference, which trips people up: `isServerMode` and
 * `isTauriMode` are *functions* (evaluated per call, so a late
 * `process.env` change is picked up), while `isProductionEnvironment` and
 * friends are precomputed *booleans* derived from `NODE_ENV` at load.
 */

import {
	APP_DIR_NAME,
	DEFAULT_AI_MODEL,
	getTauriDbPath,
	isDevelopmentEnvironment,
	isProductionEnvironment,
	isServerMode,
	isTauriMode,
	isTestEnvironment,
} from "@melandlabs/env-config";
import { info, makeCheck, runSection } from "../_helpers.ts";

export default async function demoEnvConfig() {
	await runSection("demo: @melandlabs/env-config", async () => {
		const check = makeCheck("demo/env-config");

		const tauri = isTauriMode();
		const server = isServerMode();
		info("demo/env-config", `isTauriMode()=${tauri}, isServerMode()=${server}`);
		info(
			"demo/env-config",
			`NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} → dev=${isDevelopmentEnvironment}, prod=${isProductionEnvironment}, test=${isTestEnvironment}`,
		);

		check("isTauriMode() returns a boolean", typeof tauri === "boolean", String(tauri));
		check("isServerMode() returns a boolean", typeof server === "boolean", String(server));
		check("running under plain Node is not Tauri mode", tauri === false);

		check(
			"the environment flags are precomputed booleans, not functions",
			typeof isProductionEnvironment === "boolean" && typeof isDevelopmentEnvironment === "boolean",
		);
		check(
			"at most one of dev/prod/test is true",
			[isDevelopmentEnvironment, isProductionEnvironment, isTestEnvironment].filter(Boolean).length <= 1,
		);

		info("demo/env-config", `APP_DIR_NAME=${APP_DIR_NAME}, DEFAULT_AI_MODEL=${DEFAULT_AI_MODEL}`);
		check("APP_DIR_NAME is a non-empty string", APP_DIR_NAME.length > 0, APP_DIR_NAME);
		check("DEFAULT_AI_MODEL names a model", DEFAULT_AI_MODEL.length > 0, DEFAULT_AI_MODEL);

		// Path helpers resolve without needing an actual Tauri host.
		const dbPath = getTauriDbPath();
		info("demo/env-config", `getTauriDbPath() = ${dbPath}`);
		check("getTauriDbPath() returns a path string", typeof dbPath === "string" && dbPath.length > 0);
	});
}
