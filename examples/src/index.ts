/**
 * Main runner for the @melandlabs/opencontext example smoke tests.
 *
 * Each section (one file per major capability area) exports a default
 * async function. We invoke them in sequence; any failure sets a non-zero
 * exit code via `process.exitCode`. Run with:
 *
 *     pnpm install
 *     pnpm test
 *
 * Sections live in this directory and are imported by their `default`
 * export. Adding a new package means dropping a new section file and
 * wiring it here.
 */

import testAi from "./ai.ts";
import testContracts from "./contracts.ts";
import testIntegrations from "./integrations.ts";
import testMemory from "./memory.ts";
import testOpencontext from "./opencontext.ts";
import testRag from "./rag.ts";
import testRuntime from "./runtime.ts";
import testSearch from "./search.ts";
import testSecurity from "./security.ts";
import testStorage from "./storage.ts";
import testUtilities from "./utilities.ts";
import testVoice from "./voice.ts";

const sections: Array<[string, () => Promise<void>]> = [
	["opencontext (facade)", testOpencontext],
	["ai + ai-rag + mcp", testAi],
	["memory-store + memory-consolidation", testMemory],
	["rag", testRag],
	["search", testSearch],
	["contracts", testContracts],
	["runtime (loop, hooks, ui-runtime, cron, env-config)", testRuntime],
	["storage (storage, sqlite, indexeddb)", testStorage],
	["security", testSecurity],
	["utilities (audit, config, db, insights, shared, i18n, api)", testUtilities],
	[
		"integrations (umbrella + 21 leaves + rss + integrations-runtime)",
		testIntegrations,
	],
	["voice (kokoro, whisper)", testVoice],
];

async function main() {
	console.log(
		`[smoke] running ${sections.length} section(s) against published @melandlabs/* packages`,
	);
	for (const [label, fn] of sections) {
		try {
			await fn();
		} catch (err) {
			console.error(`\n[FAIL] section '${label}' threw:`, err);
			process.exitCode = 1;
		}
	}
	if (process.exitCode === 1) {
		console.error("\n[FAIL] at least one capability check failed");
	} else {
		console.log("\n[OK] all @melandlabs/* packages verified end-to-end");
	}
}

main().catch((err) => {
	console.error("[FAIL] uncaught error during smoke test:", err);
	process.exit(1);
});
