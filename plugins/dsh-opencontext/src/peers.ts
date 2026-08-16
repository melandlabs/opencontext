/**
 * Peer-dep type augmentation and loading.
 *
 * The dsh-opencontext plugin's runtime contract is: when a host loads the
 * built `lib/index.js`, the `apply(ctx, config)` function receives a
 * Cordis `Context` and a schemastery-resolved config. We re-export the
 * module so consumers can `import type { ApplyFn, ResolvedConfig } from
 * "dsh-opencontext"` and stay decoupled from the DSH ctx surface.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { Schema } from "@deepseek-ai/schemastery";
import type { ResolvedConfig } from "./config.js";

export type DshContext = Context;

export type ApplyFn = (ctx: DshContext, config: ResolvedConfig) => void;

export type PluginDefinition = {
	name: string;
	inject?: string[];
	apply: ApplyFn;
	schema?: Schema<ResolvedConfig>;
};

export function profileNodeModulesDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	const profile = env.DSH_PROFILE?.trim() || "web";
	return join(home, "profiles", profile, "node_modules");
}

function profileModulesAnchor(env: NodeJS.ProcessEnv = process.env): string {
	return join(profileNodeModulesDir(env), "dsh-opencontext-resolver.cjs");
}

function resolvePeer(specifier: string): string {
	try {
		return createRequire(import.meta.url).resolve(specifier);
	} catch {
		return createRequire(profileModulesAnchor()).resolve(specifier);
	}
}

export async function loadPeer<T>(specifier: string): Promise<T> {
	const href = pathToFileURL(resolvePeer(specifier)).href;
	return (await import(href)) as T;
}

export { ResolvedConfig };
