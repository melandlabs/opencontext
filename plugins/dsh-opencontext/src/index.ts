/**
 * dsh-opencontext — entry point.
 *
 * Loaded by the DSH plugin loader as a Cordis plugin. The loader calls
 * `apply(ctx, config)` after resolving the schema and merging env vars.
 *
 * Wiring (in order):
 *   1. Resolve config (already done by the loader; we re-merge for env safety).
 *   2. Pick a backend (lib or http) based on `OPENCONTEXT_DSH_HTTP_URL`.
 *   3. Register the 8 `oc_*` tools.
 *   4. Register the `agent/pre-step` recall waterfall.
 *   5. Register the `agent/pre-step` capture listener (runs after recall).
 *   6. Register the `opencontext-context` skill (if the skill service is
 *      injected by the host).
 *   7. Register the `/oc` command.
 *   8. Hook cleanup: `ctx.effect(() => () => backend.dispose?.())`.
 */

import { ConfigSchema, resolveConfig, type ResolvedConfig } from "./config";
import { createBackend, type OpenContextBackend } from "./backend";
import { registerTools } from "./tools";
import { registerRecall } from "./recall";
import { registerCapture } from "./capture";
import { registerSkill } from "./skill";
import { registerCommand } from "./commands";

export const name = "dsh-opencontext";

export const inject: string[] = [
	"tools",
	"agents",
	"agentDefaultModel",
	"systemPrompt",
	"skill",
	"commands",
	"llm",
	"sessions",
];

export { ConfigSchema };
export type { ResolvedConfig } from "./config";
export type { OpenContextBackend } from "./backend";

interface CordisContext {
	tools: { register: (tool: unknown) => () => void };
	on: (event: string, handler: (...args: never[]) => unknown) => () => void;
	get: (name: string) => unknown;
	logger: { warn: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
	effect: (setup: () => () => void) => () => void;
}

export function apply(ctx: CordisContext, config: ResolvedConfig): void {
	const resolved: ResolvedConfig = resolveConfig(config as Partial<ResolvedConfig>);
	const backend: OpenContextBackend = createBackend(resolved);
	ctx.logger.info?.(
		`[dsh-opencontext] active backend=${backend.mode} scope=${resolved.scopeId || "(auto)"} maxBytes=${resolved.maxBytes}`,
	);

	const disposers: Array<() => void> = [];
	disposers.push(
		registerTools(ctx as { tools: { register: (tool: unknown) => () => void } }, backend, resolved),
	);
	disposers.push(registerRecall(ctx, backend, resolved));
	disposers.push(registerCapture(ctx, backend, resolved));
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
