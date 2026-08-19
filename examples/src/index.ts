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
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import demoVsa from "./simple/19-vsa.ts";
import { startHttpServer } from "@melandlabs/memory-store/http";
import { withTmp } from "./_helpers.ts";
import demoHelloMemory from "./tutorials/00-hello-memory.ts";
import demoRememberExample from "./tutorials/01-remember-example.ts";
import demoRecallExample from "./tutorials/02-recall-example.ts";
import demoForgetExample from "./tutorials/03-forget-example.ts";
import demoImproveExample from "./tutorials/04-improve-example.ts";
import demoTimeTravelExample from "./tutorials/05-time-travel-example.ts";
import demoMinimalConfig from "./tutorials/06-minimal-config-example.ts";
import demoLocalEmbeddingsExample from "./tutorials/07-local-embeddings-example.ts";
import demoLocalEmbeddingsFullSetup from "./tutorials/08-local-embeddings-full-setup.ts";
import demoHttpClientExample from "./tutorials/09-http-client-example.ts";
import demoReasoningMemoryExample from "./tutorials/10-reasoning-memory-example.ts";
import demoLoopExample from "./tutorials/11-loop-example.ts";
import demoIntegrationIdsExample from "./tutorials/12-integration-ids-example.ts";
import demoBatchExample from "./tutorials/13-batch-example.ts";
import demoMemoryService from "./tutorials/17-memory-service.ts";
import demoRememberEverythingExample from "./tutorials/18-remember-everything-example.ts";
import demoWarningHandlingExample from "./tutorials/19-warning-handling-example.ts";
import demoMetadataExample from "./tutorials/20-metadata-example.ts";
import demoScheduledTasksExample from "./tutorials/21-scheduled-tasks-example.ts";
import demoTokenEncryptionExample from "./tutorials/22-token-encryption-example.ts";
import demoUrlValidationExample from "./tutorials/23-url-validation-example.ts";
import demoWebSearchExample from "./tutorials/24-web-search-example.ts";
import demoAuditLoggingExample from "./tutorials/25-audit-logging-example.ts";
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
import demoPeerProfile from "./tutorials/41-peer-profile-example.ts";
import demoPersonalMemoryAssistant from "./tutorials/use-cases/30-personal-memory-assistant.ts";
import demoCustomerSupportAgent from "./tutorials/use-cases/31-customer-support-agent.ts";
import demoResearchKnowledgeTracker from "./tutorials/use-cases/32-research-knowledge-tracker.ts";
import demoPeerRelationshipExplorer from "./tutorials/use-cases/33-peer-relationship-explorer.ts";

const demos: Array<[string, () => Promise<void>]> = [
	["demo: opencontext (facade)", demoFacade],
	["demo: opencontext — hello memory", demoHelloMemory],
	["demo: opencontext — remember (storeMessages)", demoRememberExample],
	["demo: opencontext — recall (search)", demoRecallExample],
	["demo: opencontext — forget (archiveMessages)", demoForgetExample],
	["demo: opencontext — improve (deprecateMessages)", demoImproveExample],
	["demo: opencontext — time-travel (asOf search)", demoTimeTravelExample],
	["demo: opencontext — minimal config (sqlite-vec backend)", demoMinimalConfig],
	["demo: opencontext — local embeddings (Transformers + messages)", demoLocalEmbeddingsExample],
	["demo: opencontext — local embeddings full setup", demoLocalEmbeddingsFullSetup],
	["demo: opencontext — HTTP client (boots an in-process memory daemon first)", runHttpClientWithServer],
	["demo: opencontext — reasoning memory (LLM-backed)", demoReasoningMemoryExample],
	["demo: opencontext — Loop preferences", demoLoopExample],
	["demo: opencontext — integration ids", demoIntegrationIdsExample],
	["demo: opencontext — batch storeMessages", demoBatchExample],
	["demo: opencontext — memory service", demoMemoryService],
	["demo: opencontext — remember everything", demoRememberEverythingExample],
	["demo: opencontext — warning handling", demoWarningHandlingExample],
	["demo: opencontext — metadata", demoMetadataExample],
	["demo: opencontext — scheduled tasks (cron)", demoScheduledTasksExample],
	["demo: opencontext — token encryption", demoTokenEncryptionExample],
	["demo: opencontext — URL validation (SSRF)", demoUrlValidationExample],
	["demo: opencontext — web search (Brave)", demoWebSearchExample],
	["demo: opencontext — audit logging", demoAuditLoggingExample],
	["demo: rag — chunking", demoRagChunk],
	["demo: rag — SQLiteVecStore", demoRagVectorStore],
	["demo: memory-store", demoMemoryStore],
	["demo: ai — tokens & pricing", demoAi],
	["demo: ai — IAgent + StandaloneAgent (built-in single-shot LLM provider)", demoAiAgent],
	["demo: ai — ClaudeAgent (Claude Code provider)", demoClaudeAgent],
	["demo: ai — CodexAgent (OpenAI Codex CLI provider)", demoCodexAgent],
	["demo: contracts", demoContracts],
	["demo: contracts — direct package tutorial", demoContractsTutorial],
	[
		"demo: memory-store — peer-profile facade (createPeerProfile + getProfile/getRelationships)",
		demoPeerProfile,
	],
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
	["demo: use-case — personal memory assistant", demoPersonalMemoryAssistant],
	["demo: use-case — customer support agent", demoCustomerSupportAgent],
	["demo: use-case — research knowledge tracker", demoResearchKnowledgeTracker],
	["demo: use-case — peer relationship explorer (research-lab collaboration)", demoPeerRelationshipExplorer],
];

/**
 * The 09 HTTP-client demo expects a memory server already running at
 * MEMORY_URL. Boot one on a random high port inside a scratch dir, point
 * the demo at it via MEMORY_URL, then tear it down — even on failure.
 */
async function runHttpClientWithServer() {
	await withTmp("http-client", async (dir) => {
		const previousDbPath = process.env.MEMORY_STORE_DB_PATH;
		process.env.MEMORY_STORE_DB_PATH = `${dir}/store.db`;
		const previousUrl = process.env.MEMORY_URL;

		const port = 30_000 + Math.floor(Math.random() * 10_000);
		const started = await startHttpServer({ port, host: "127.0.0.1" });
		process.env.MEMORY_URL = started.url;
		console.log(`[INFO] demo/http-client: daemon listening at ${started.url}`);

		try {
			await demoHttpClientExample();
		} finally {
			await started.stop();
			// biome-ignore lint/performance/noDelete: `delete` is the only way to unset an env var; assigning `undefined` stores the string "undefined".
			if (previousUrl === undefined) delete process.env.MEMORY_URL;
			else process.env.MEMORY_URL = previousUrl;
			// biome-ignore lint/performance/noDelete: same rationale as above.
			if (previousDbPath === undefined) delete process.env.MEMORY_STORE_DB_PATH;
			else process.env.MEMORY_STORE_DB_PATH = previousDbPath;
		}
	});
}

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

	// Several tutorials rely on the default `~/.opencontext/{memory,logs}` paths.
	// On a clean CI runner (or any host with a brand-new $HOME) the parent
	// directory does not exist, which makes better-sqlite3 throw "Cannot
	// open database because the directory does not exist". Pre-create both
	// so demos that don't pass an explicit dbPath still run.
	const home = process.env.HOME || homedir();
	await Promise.all([
		mkdir(join(home, ".opencontext", "memory"), { recursive: true }),
		mkdir(join(home, ".opencontext", "logs"), { recursive: true }),
	]);

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
