import type { AgentPlugin } from "../plugin";
import { getAgentRegistry } from "../registry";
import type { AgentProvider } from "../types";
import { NativeAgentRequestError } from "./native-runner";

type ProviderLoader = () => Promise<AgentPlugin>;

/**
 * Loader map for native agents whose runtime is implemented inside
 * `@melandlabs/ai`. The Claude runtime is intentionally excluded: it lives in
 * `apps/web` because it is tightly coupled to web-app concerns (auth, MCP
 * servers, billing, capability profiles) that don't belong in a reusable
 * package. Hosts must register the Claude plugin directly with the agent
 * registry before invoking `registerNativeAgentProvider("claude")`.
 */
const PROVIDER_LOADERS: Record<string, ProviderLoader> = {
	codex: async () => {
		const { codexAgentPlugin } = await import("../providers/codex");
		return codexAgentPlugin;
	},
	hermes: async () => {
		const { hermesAgentPlugin } = await import("../providers/hermes");
		return hermesAgentPlugin;
	},
	openclaw: async () => {
		const { openclawAgentPlugin } = await import("../providers/openclaw");
		return openclawAgentPlugin;
	},
	opencode: async () => {
		const { opencodeAgentPlugin } = await import("../providers/opencode");
		return opencodeAgentPlugin;
	},
};

const registrationPromises = new Map<string, Promise<void>>();

/**
 * Load and register exactly one native provider.
 *
 * Keeping each dynamic import pointed at the provider module (instead of the
 * extensions barrel) is important: the packaged one-shot bundle must not
 * initialize unrelated SDKs before provider selection.
 */
export async function registerNativeAgentProvider(provider: AgentProvider) {
	const registry = getAgentRegistry();
	if (registry.has(provider)) {
		return;
	}

	const existing = registrationPromises.get(provider);
	if (existing) {
		await existing;
		return;
	}

	const loader = PROVIDER_LOADERS[provider];
	if (!loader) {
		throw new NativeAgentRequestError(
			provider === "claude"
				? 'The Claude runtime is registered by the host application (apps/web) before this loader is called. Ensure the host has registered its Claude plugin with the agent registry before invoking `registerNativeAgentProvider("claude")`.'
				: `Unsupported native agent provider: ${provider}.`,
			500,
		);
	}

	const registration = loader().then((plugin) => registry.register(plugin));

	registrationPromises.set(provider, registration);
	try {
		await registration;
	} finally {
		// This map only deduplicates concurrent imports. The registry remains the
		// source of truth, so an explicitly unregistered provider can be loaded
		// again later and failed imports remain retryable.
		if (registrationPromises.get(provider) === registration) {
			registrationPromises.delete(provider);
		}
	}
}
