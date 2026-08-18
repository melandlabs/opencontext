/**
 * Tutorial: environment mode detection.
 *
 * This example demonstrates the env-config exports (provided by
 * @melandlabs/env-config and intended to be re-exported by
 * @melandlabs/opencontext):
 *
 *   - isTauriMode()
 *   - isServerMode()
 *   - DEFAULT_AI_MODEL
 *   - APP_DIR_NAME
 *
 * It performs static surface checks, calls the runtime detectors, and prints
 * the current environment values. In a plain Node.js run isServerMode() is
 * expected to be true and isTauriMode() false.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/30-env-config-example.ts
 */

import { APP_DIR_NAME, DEFAULT_AI_MODEL, isServerMode, isTauriMode } from "@melandlabs/env-config";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- isTauriMode is callable: ${typeof isTauriMode === "function"}`);
	console.log(`- isServerMode is callable: ${typeof isServerMode === "function"}`);
	console.log(
		`- DEFAULT_AI_MODEL is a string: ${typeof DEFAULT_AI_MODEL === "string"} (${DEFAULT_AI_MODEL})`,
	);
	console.log(`- APP_DIR_NAME is a string: ${typeof APP_DIR_NAME === "string"} (${APP_DIR_NAME})`);

	if (typeof isTauriMode !== "function") {
		throw new Error("isTauriMode is not exported as a function");
	}
	if (typeof isServerMode !== "function") {
		throw new Error("isServerMode is not exported as a function");
	}
	if (typeof DEFAULT_AI_MODEL !== "string" || DEFAULT_AI_MODEL.length === 0) {
		throw new Error("DEFAULT_AI_MODEL is not exported as a non-empty string");
	}
	if (typeof APP_DIR_NAME !== "string" || APP_DIR_NAME.length === 0) {
		throw new Error("APP_DIR_NAME is not exported as a non-empty string");
	}

	// ---- Runtime environment detection ----
	console.log("\nRuntime environment detection:");
	const tauri = isTauriMode();
	const server = isServerMode();
	console.log(`- isTauriMode() = ${tauri}`);
	console.log(`- isServerMode() = ${server}`);

	if (typeof tauri !== "boolean") {
		throw new Error(`isTauriMode() returned ${typeof tauri}, expected boolean`);
	}
	if (typeof server !== "boolean") {
		throw new Error(`isServerMode() returned ${typeof server}, expected boolean`);
	}
	if (tauri === server) {
		throw new Error(`isTauriMode() and isServerMode() should be opposites (got ${tauri} and ${server})`);
	}

	// When running under plain Node.js we expect server mode.
	if (!tauri && server) {
		console.log("- Detected: plain Node.js / server mode");
	}

	console.log("\n[OK] Env-config tutorial completed");
}

export default main;

runIfMain("EnvConfig tutorial", main);
