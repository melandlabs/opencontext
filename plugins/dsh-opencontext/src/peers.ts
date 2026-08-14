/**
 * Peer-dep type augmentation.
 *
 * The dsh-opencontext plugin's runtime contract is: when a host loads the
 * built `lib/index.js`, the `apply(ctx, config)` function receives a
 * Cordis `Context` and a schemastery-resolved config. We re-export the
 * module so consumers can `import type { ApplyFn, ResolvedConfig } from
 * "dsh-opencontext"` and stay decoupled from the DSH ctx surface.
 */

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

export { ResolvedConfig };
