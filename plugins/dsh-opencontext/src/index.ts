/**
 * dsh-opencontext — entry point.
 *
 * Loaded by the DSH plugin loader as a Cordis plugin. The loader calls
 * `apply(ctx, config)` after resolving the schema and merging env vars.
 *
 * Wiring (in order):
 *   1. Resolve config (already done by the loader; we re-merge for env safety).
 *   2. Pick a backend (lib or http) based on `OPENCONTEXT_DSH_HTTP_URL`.
 *   3. Register the core `oc_*` tools (8 tools).
 *   4. Register insights tools (2 tools, if enabled).
 *   5. Register knowledge/RAG tools (3 tools, if enabled).
 *   6. Register summary tools (3 tools).
 *   7. Register the `agent/pre-step` recall waterfall.
 *   8. Register the `agent/pre-step` capture listener (runs after recall).
 *   9. Register the `turn/end` listener (for session summarization).
 *   10. Register the `tool/result` listener (for tool output capture).
 *   11. Register the `opencontext` skill (if the skill service is injected).
 *   12. Register the `/oc` command.
 *   13. Hook cleanup: `ctx.effect(() => () => backend.dispose?.())`.
 */

import { ConfigSchema, resolveConfig, type ResolvedConfig } from "./config.js";
import { createBackend, type OpenContextBackend } from "./backend.js";
import { registerTools } from "./tools.js";
import { registerRecall } from "./recall.js";
import { registerCapture } from "./capture.js";
import { registerSkill } from "./skill.js";
import { registerCommand } from "./commands.js";
import { registerInsightsTools } from "./tools-insights.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerSummaryTools } from "./tools-summary.js";
import { registerTurnEndListener } from "./events-turn-end.js";
import { registerToolResultListener } from "./events-tool-result.js";

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

export function apply(ctx: CordisContext, config: ResolvedConfig): void {
	const resolved: ResolvedConfig = resolveConfig(
		config as Partial<ResolvedConfig>
	);
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
		} maxBytes=${resolved.maxBytes} features=${features.join(",") || "core"}`
	);

	const disposers: Array<() => void> = [];

	// Core tools (always registered)
	disposers.push(
		registerTools(
			ctx as { tools: { register: (tool: unknown) => () => void } },
			backend,
			resolved
		)
	);

	// Optional tools based on config
	if (resolved.enableInsights) {
		disposers.push(
			registerInsightsTools(
				ctx as { tools: { register: (tool: unknown) => () => void } },
				backend,
				resolved
			)
		);
	}
	if (resolved.enableKnowledge) {
		disposers.push(
			registerKnowledgeTools(
				ctx as { tools: { register: (tool: unknown) => () => void } },
				backend,
				resolved
			)
		);
	}

	// Summary tools (always available)
	disposers.push(
		registerSummaryTools(
			ctx as { tools: { register: (tool: unknown) => () => void } },
			backend,
			resolved
		)
	);

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
