/**
 * Main runner for the @melandlabs/opencontext examples.
 *
 * This workspace holds runnable documentation, one file per package
 * published from the monorepo. Every demo calls a package's real public
 * API and asserts on the value it actually returned: real SQLite files,
 * real Fernet ciphertexts, real chunk boundaries, real preferences on
 * disk, real SSRF rejections. If a demo's `[OK  ]` line printed, the
 * code in that file is code you can copy.
 *
 * Browser-only packages (hooks, indexeddb, voice-kokoro) and CJS-only
 * integration leaves (weixin, whatsapp, …) are not exercised here —
 * they have no Node-callable headline API to demonstrate. Most other
 * packages are covered either by a demo below or by the per-package
 * vitest suites under packages/*\/src/\*.test.ts.
 *
 * Any failing check sets a non-zero exit code via `process.exitCode`.
 * Run with:
 *
 *     pnpm install
 *     pnpm test
 */

import demoFacade from "./simple/00-facade.ts";
import demoRagChunk from "./simple/01-rag-chunk.ts";
import demoRagVectorStore from "./simple/02-rag-vector-store.ts";
import demoMemoryStore from "./simple/03-memory-store.ts";
import demoAi from "./simple/04-ai.ts";
import demoContracts from "./simple/05-contracts.ts";
import demoLoop from "./simple/06-loop.ts";
import demoEnvConfig from "./simple/07-env-config.ts";
import demoCron from "./simple/08-cron.ts";
import demoUiRuntime from "./simple/09-ui-runtime.ts";
import demoStorage from "./simple/10-storage.ts";
import demoSecurity from "./simple/11-security.ts";
import demoSearch from "./simple/12-search.ts";
import demoIntegrationsCore from "./simple/13-integrations-core.ts";
import demoLocalEmbedding from "./simple/14-local-embedding.ts";
import demoHttpServer from "./simple/15-http-server.ts";
import demoMcpServer from "./simple/16-mcp-server.ts";
import demoAiAgent from "./simple/17-ai-agent.ts";
import demoVsa from "./simple/19-vsa.ts";
import demoClaudeAgent from "./tutorials/26-claude-agent-example.ts";
import demoCodexAgent from "./tutorials/27-codex-agent-example.ts";
import demoAudit from "./tutorials/28-audit-example.ts";
import demoCronTutorial from "./tutorials/29-cron-example.ts";
import demoEnvConfigTutorial from "./tutorials/30-env-config-example.ts";
import demoStorageTutorial from "./tutorials/31-storage-example.ts";
import demoInsights from "./tutorials/32-insights-example.ts";
import demoSearchTutorial from "./tutorials/33-search-example.ts";
import demoApi from "./tutorials/34-api-example.ts";
import demoDb from "./tutorials/35-db-example.ts";
import demoSqlite from "./tutorials/36-sqlite-example.ts";
import demoMemoryConsolidation from "./tutorials/37-memory-consolidation-example.ts";
import demoChannels from "./tutorials/38-channels-example.ts";
import demoIntegrationsRuntime from "./tutorials/39-integrations-runtime-example.ts";
import demoContractsTutorial from "./tutorials/40-contracts-example.ts";

const demos: Array<[string, () => Promise<void>]> = [
	["demo: opencontext (facade)", demoFacade],
	["demo: rag — chunking", demoRagChunk],
	["demo: rag — SQLiteVecStore", demoRagVectorStore],
	["demo: memory-store", demoMemoryStore],
	["demo: ai — tokens & pricing", demoAi],
	["demo: ai — IAgent + StandaloneAgent (built-in single-shot LLM provider)", demoAiAgent],
	["demo: ai — ClaudeAgent (Claude Code provider)", demoClaudeAgent],
	["demo: ai — CodexAgent (OpenAI Codex CLI provider)", demoCodexAgent],
	["demo: contracts", demoContracts],
	["demo: contracts — direct package tutorial", demoContractsTutorial],
	["demo: loop — preferences", demoLoop],
	["demo: env-config", demoEnvConfig],
	["demo: env-config — direct package tutorial", demoEnvConfigTutorial],
	["demo: cron", demoCron],
	["demo: cron — direct package tutorial", demoCronTutorial],
	["demo: ui-runtime", demoUiRuntime],
	["demo: storage", demoStorage],
	["demo: storage — direct package tutorial", demoStorageTutorial],
	["demo: security", demoSecurity],
	["demo: search", demoSearch],
	["demo: search — direct package tutorial", demoSearchTutorial],
	["demo: audit — direct package tutorial", demoAudit],
	["demo: api — direct package tutorial", demoApi],
	["demo: db — direct package tutorial", demoDb],
	["demo: sqlite — direct package tutorial", demoSqlite],
	["demo: insights — direct package tutorial", demoInsights],
	["demo: memory-consolidation — direct package tutorial", demoMemoryConsolidation],
	["demo: integrations/channels — direct package tutorial", demoChannels],
	["demo: integrations-runtime — direct package tutorial", demoIntegrationsRuntime],
	["demo: integrations — core & utils", demoIntegrationsCore],
	["demo: ai-rag — local Transformers embedding", demoLocalEmbedding],
	["demo: memory-store — fully-wired HTTP daemon (all 3 unified deps)", demoHttpServer],
	["demo: opencontext — fully-wired MCP server (stdio, all unified deps)", demoMcpServer],
	["demo: memory-store — Vector Symbolic Architecture (VSA) verb", demoVsa],
];

async function runAll(label: string, sections: Array<[string, () => Promise<void>]>) {
	console.log(`\n${"═".repeat(64)}\n${label}\n${"═".repeat(64)}`);
	for (const [name, fn] of sections) {
		try {
			await fn();
		} catch (err) {
			console.error(`\n[FAIL] section '${name}' threw:`, err);
			process.exitCode = 1;
		}
	}
}

async function main() {
	console.log(`[examples] ${demos.length} demo section(s) against the @melandlabs/* packages`);

	await runAll("DEMOS — runnable documentation (real API calls)", demos);

	if (process.exitCode === 1) {
		console.error("\n[FAIL] at least one check failed");
	} else {
		console.log("\n[OK] every demo ran against the real API");
	}
}

main().catch((err) => {
	console.error("[FAIL] uncaught error while running examples:", err);
	process.exit(1);
});
