/**
 * dsh-opencontext — entry point.
 *
 * Loaded by the DSH plugin loader as a Cordis plugin. The loader calls
 * `apply(ctx, config)` after resolving the schema and merging env vars.
 *
 * Wiring (in order):
 *   1. Resolve config (already done by the loader; we re-merge for env safety).
 *   2. Pick a backend (lib or http) based on `OPENCONTEXT_DSH_HTTP_URL`.
 *   3. Load DSH tools peer dependency for proper tool registration.
 *   4. Register the core `oc_*` tools (8 tools).
 *   5. Register insights tools (2 tools, if enabled).
 *   6. Register knowledge/RAG tools (3 tools, if enabled).
 *   7. Register summary tools (3 tools).
 *   8. Register the `agent/pre-step` recall waterfall.
 *   9. Register the `agent/pre-step` capture listener (runs after recall).
 *   10. Register the `turn/end` listener (for session summarization).
 *   11. Register the `tool/result` listener (for tool output capture).
 *   12. Register the `opencontext` skill (if the skill service is injected).
 *   13. Register the `/oc` command.
 *   14. Hook cleanup: `ctx.effect(() => () => backend.dispose?.())`.
 */

import { type OpenContextBackend, createBackend } from "./backend.js";
import { registerCapture } from "./capture.js";
import { registerCommand } from "./commands.js";
import { ConfigSchema, type ResolvedConfig, resolveConfig } from "./config.js";
import { registerToolResultListener } from "./events-tool-result.js";
import { registerTurnEndListener } from "./events-turn-end.js";
import { loadPeer } from "./peers.js";
import { registerRecall } from "./recall.js";
import { registerSkill } from "./skill.js";
import { registerInsightsTools } from "./tools-insights.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerSummaryTools } from "./tools-summary.js";
import { registerTools } from "./tools.js";

export const name = "dsh-opencontext";

export const inject: string[] = [
	"tools",
	"agents",
	"agentDefaultModel",
	"systemPrompt",
	"commands",
	"llm",
	"sessions",
];

export { ConfigSchema };
export type { ResolvedConfig } from "./config.js";
export type { OpenContextBackend } from "./backend.js";

type DefineTool = (definition: Record<string, unknown>) => unknown;

interface PluginRuntime {
	backend: OpenContextBackend;
	config: ResolvedConfig;
}

interface CordisContext {
	tools: { register: (tool: unknown) => () => void };
	on: (event: string, handler: (...args: never[]) => unknown) => () => void;
	get: (name: string) => unknown;
	logger: {
		warn: (msg: string) => void;
		debug?: (msg: string) => void;
		info?: (msg: string) => void;
	};
	effect: (setup: () => () => void) => () => void;
}

export async function apply(ctx: CordisContext, config: ResolvedConfig): Promise<void> {
	const resolved: ResolvedConfig = resolveConfig(config as Partial<ResolvedConfig>);
	const backend: OpenContextBackend = createBackend(resolved);

	// Log enabled features
	const features: string[] = [];
	if (resolved.enableInsights) features.push("insights");
	if (resolved.enableKnowledge) features.push("knowledge");
	if (resolved.autoSummarize) features.push("auto-summarize");
	if (resolved.captureToolResults) features.push("tool-capture");
	if (resolved.capturePrompts) features.push("prompt-capture");

	ctx.logger.info?.(
		`[dsh-opencontext] active backend=${backend.mode} scope=${
			resolved.scopeId || "(auto)"
		} maxBytes=${resolved.maxBytes} features=${features.join(",") || "core"}`,
	);

	const disposers: Array<() => void> = [];

	// Load DSH tools peer dependency for proper tool registration
	const toolsMod = await loadPeer<{ defineTool: DefineTool }>("@deepseek-ai/dsh-tools");
	const runtime: PluginRuntime = { backend, config: resolved };

	// Core tools (always registered)
	disposers.push(registerTools(ctx, runtime, toolsMod.defineTool));

	// Optional tools based on config
	if (resolved.enableInsights) {
		disposers.push(registerInsightsTools(ctx, runtime, toolsMod.defineTool));
	}
	if (resolved.enableKnowledge) {
		disposers.push(registerKnowledgeTools(ctx, runtime, toolsMod.defineTool));
	}

	// Summary tools (always available)
	disposers.push(registerSummaryTools(ctx, runtime, toolsMod.defineTool));

	// Event listeners
	disposers.push(registerRecall(ctx, backend, resolved));
	disposers.push(registerCapture(ctx, backend, resolved));
	disposers.push(registerTurnEndListener(ctx, backend, resolved));
	disposers.push(registerToolResultListener(ctx, backend, resolved));

	// Skill and command
	disposers.push(registerSkill(ctx));
	disposers.push(registerCommand(ctx, backend, resolved));

	ctx.effect(() => {
		return async () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					// ignore
				}
			}
			if (backend.dispose) {
				try {
					await backend.dispose();
				} catch {
					// ignore
				}
			}
		};
	});
}

export default { name, inject, ConfigSchema, apply };
