/**
 * commands — register the `/oc` command (currently exposes `/oc doctor`).
 */

import { classifyBackendError, constants } from "./errors.js";
import { getOpenContextPath } from "@melandlabs/env-config";
import type { OpenContextBackend } from "./backend.js";
import type { ResolvedConfig } from "./config.js";

interface CommandService {
	register(definition: {
		name: string;
		description: string;
		handler: (invocation: {
			rawInput: string;
			signal: AbortSignal;
			agent: { session: { header: { id: string; cwd: string } } };
		}) => Promise<{ kind: "success" | "error"; text: string }>;
	}): () => void;
}

interface CommandInvocation {
	rawInput: string;
	signal: AbortSignal;
	agent: { session: { header: { id: string; cwd: string } } };
}

async function handleDoctor(
	backend: OpenContextBackend,
	config: ResolvedConfig,
): Promise<{ kind: "success" | "error"; text: string }> {
	const probe = await backend.health();
	const scope = config.scopeId || "(auto)";
	const url = backend.mode === "http" ? (process.env.OPENCONTEXT_DSH_HTTP_URL ?? config.baseUrl) : "(lib)";
	const libPath = process.env.MEMORY_STORE_DB_PATH ?? getOpenContextPath("memory", "store.db");

	let recentCount: number | null = null;
	try {
		const items = await backend.list(
			{ limit: 1, scopeId: scope, userId: scope },
			{ timeoutMs: Math.min(config.timeoutMs, 2000) },
		);
		recentCount = items.length;
	} catch (error) {
		const cls = classifyBackendError(error);
		return {
			kind: "error",
			text: JSON.stringify(
				{
					ok: false,
					plugin: constants.PLUGIN_NAME,
					backend: backend.mode,
					url,
					scope,
					probe,
					listError: { code: cls.code, message: cls.message },
				},
				null,
				2,
			),
		};
	}

	return {
		kind: probe.ok ? "success" : "error",
		text: JSON.stringify(
			{
				ok: probe.ok,
				plugin: constants.PLUGIN_NAME,
				backend: backend.mode,
				scope,
				url: backend.mode === "http" ? url : undefined,
				db: backend.mode === "lib" ? libPath : undefined,
				probe,
				recentCount,
			},
			null,
			2,
		),
	};
}

export function registerCommand(
	ctx: { get: (name: string) => unknown; logger?: { warn?: (msg: string) => void } },
	backend: OpenContextBackend,
	config: ResolvedConfig,
): () => void {
	const commands = ctx.get("commands") as CommandService | undefined;
	if (!commands || typeof commands.register !== "function") {
		ctx.logger?.warn?.("[dsh-opencontext] commands service not available");
		return () => undefined;
	}

	return commands.register({
		name: "oc",
		description: "OpenContext status, search, remember, and diagnostics.",
		handler: async (invocation: CommandInvocation) => {
			try {
				const trimmed = (invocation.rawInput ?? "").trim();
				const sub = trimmed.split(/\s+/).filter(Boolean)[0] ?? "";
				if (sub === "doctor" || sub === "") {
					return await handleDoctor(backend, config);
				}
				return {
					kind: "error",
					text: `Unknown /oc subcommand: ${sub}. Try /oc doctor.`,
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					kind: "error",
					text: `Command failed: ${errorMessage}`,
				};
			}
		},
	});
}
