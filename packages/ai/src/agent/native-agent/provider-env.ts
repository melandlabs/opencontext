import type { AgentProvider } from "../types";
import { type NativeAgentRequest, NativeAgentRequestError } from "./native-runner";
import { type SelectableAgentRuntime, readAgentRuntimePreference } from "./runtime-preference";

type EnvSource = Record<string, string | undefined>;

interface ProviderResolutionOptions {
	preferencePath?: string;
}

export interface ConfiguredAgentProviderResolution {
	provider: AgentProvider;
	preference?: SelectableAgentRuntime;
	source: "preference" | "environment" | "default";
}

const DEFAULT_AGENT_PROVIDER: AgentProvider = "claude";
const ENV_PROVIDER_KEY = "OPENCONTEXT_AGENT_PROVIDER";
const OPENCODE_PROVIDER = "opencode";
const HERMES_PROVIDER = "hermes";
const OPENCLAW_PROVIDER = "openclaw";
const CODEX_PROVIDER = "codex";
const SUPPORTED_ENV_PROVIDERS = new Set([
	"claude",
	OPENCODE_PROVIDER,
	HERMES_PROVIDER,
	OPENCLAW_PROVIDER,
	CODEX_PROVIDER,
]);

export function getConfiguredDefaultAgentProvider(
	env: EnvSource = process.env,
	options: ProviderResolutionOptions = {},
): AgentProvider {
	return getConfiguredAgentProviderResolution(env, options).provider;
}

export function getConfiguredAgentProviderResolution(
	env: EnvSource = process.env,
	options: ProviderResolutionOptions = {},
): ConfiguredAgentProviderResolution {
	if (isTauriEnvironment(env)) {
		const preference = readAgentRuntimePreference(options.preferencePath);
		if (preference) {
			return { provider: preference, preference, source: "preference" };
		}
	}

	const environmentProvider = resolveEnvAgentProvider(env);
	return environmentProvider
		? { provider: environmentProvider, source: "environment" }
		: { provider: DEFAULT_AGENT_PROVIDER, source: "default" };
}

export function resolveNativeAgentProviderRequest(
	body: NativeAgentRequest,
	env: EnvSource = process.env,
	options: ProviderResolutionOptions = {},
): NativeAgentRequest {
	// Runtime selection is deployment configuration, not an HTTP request
	// option. External CLI agents inherit host credentials and can execute local
	// tools, so allowing callers to switch providers would cross a trust boundary.
	const provider = getConfiguredDefaultAgentProvider(env, options);

	if (provider === HERMES_PROVIDER) {
		const hermesEnvConfig = resolveHermesEnvConfig(env);
		// The chat UI's model selector describes the built-in Claude runtime. Do
		// not forward that unrelated model/base URL/API key bundle into Hermes.
		return {
			...body,
			provider,
			modelConfig: hermesEnvConfig.model ? { model: hermesEnvConfig.model } : undefined,
			// Executable paths, profiles, environment, and process timeouts are a
			// server trust boundary. Never accept them from an HTTP request.
			providerConfig: hermesEnvConfig.providerConfig,
		};
	}

	if (provider === OPENCLAW_PROVIDER) {
		return {
			...body,
			provider,
			modelConfig: undefined,
			providerConfig: resolveOpenClawEnvConfig(env),
		};
	}

	if (provider === CODEX_PROVIDER) {
		const codexEnvConfig = resolveCodexEnvConfig(env);
		return {
			...body,
			provider,
			modelConfig: codexEnvConfig.model ? { model: codexEnvConfig.model } : undefined,
			providerConfig: codexEnvConfig.providerConfig,
		};
	}

	if (provider !== OPENCODE_PROVIDER) {
		return {
			...body,
			provider,
			providerConfig: undefined,
		};
	}

	const opencodeEnvConfig = resolveOpenCodeEnvConfig(env);

	return {
		...body,
		provider,
		modelConfig: opencodeEnvConfig.model ? { model: opencodeEnvConfig.model } : undefined,
		providerConfig: opencodeEnvConfig.providerConfig,
	};
}

function isTauriEnvironment(env: EnvSource): boolean {
	return typeof env.TAURI_MODE === "string" || env.IS_TAURI === "true";
}

function resolveEnvAgentProvider(env: EnvSource): AgentProvider | undefined {
	const rawProvider = normalizeOptionalString(env[ENV_PROVIDER_KEY]);
	if (!rawProvider) {
		return undefined;
	}

	const provider = rawProvider.toLowerCase();
	if (!SUPPORTED_ENV_PROVIDERS.has(provider)) {
		throwConfigError(
			`Unsupported ${ENV_PROVIDER_KEY}: ${rawProvider}. Supported values: claude, opencode, hermes, openclaw, codex.`,
		);
	}

	return provider as AgentProvider;
}

function resolveHermesEnvConfig(env: EnvSource) {
	const providerConfig: Record<string, unknown> = {};
	const command = normalizeOptionalString(env.OPENCONTEXT_AGENT_HERMES_COMMAND);
	const profile = normalizeOptionalString(env.OPENCONTEXT_AGENT_HERMES_PROFILE);
	const model = normalizeOptionalString(env.OPENCONTEXT_AGENT_HERMES_MODEL);
	const inferenceProvider = normalizeOptionalString(env.OPENCONTEXT_AGENT_HERMES_PROVIDER);
	const timeoutMs = parsePositiveIntegerEnv(env, "OPENCONTEXT_AGENT_HERMES_TIMEOUT_MS");

	if (inferenceProvider && !model) {
		throwConfigError("OPENCONTEXT_AGENT_HERMES_PROVIDER requires OPENCONTEXT_AGENT_HERMES_MODEL.");
	}

	if (command) {
		providerConfig.hermesPath = command;
	}
	if (profile) {
		providerConfig.profile = profile;
	}
	if (timeoutMs !== undefined) {
		providerConfig.timeoutMs = timeoutMs;
	}

	return {
		model: model && inferenceProvider ? `${inferenceProvider}:${model}` : model,
		providerConfig,
	};
}

function resolveCodexEnvConfig(env: EnvSource) {
	const providerConfig: Record<string, unknown> = {};
	const command = normalizeOptionalString(env.OPENCONTEXT_AGENT_CODEX_COMMAND);
	const profile = normalizeOptionalString(env.OPENCONTEXT_AGENT_CODEX_PROFILE);
	const model = normalizeOptionalString(env.OPENCONTEXT_AGENT_CODEX_MODEL);
	const sandbox = normalizeOptionalString(env.OPENCONTEXT_AGENT_CODEX_SANDBOX);
	const skipGitRepoCheck = parseBooleanEnv(env, "OPENCONTEXT_AGENT_CODEX_SKIP_GIT_REPO_CHECK");
	const fullAuto = parseBooleanEnv(env, "OPENCONTEXT_AGENT_CODEX_FULL_AUTO");
	const timeoutMs = parsePositiveIntegerEnv(env, "OPENCONTEXT_AGENT_CODEX_TIMEOUT_MS");

	if (
		sandbox &&
		sandbox !== "read-only" &&
		sandbox !== "workspace-write" &&
		sandbox !== "danger-full-access"
	) {
		throwConfigError(
			`OPENCONTEXT_AGENT_CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access. Received: ${sandbox}.`,
		);
	}

	if (command) {
		providerConfig.codexPath = command;
	}
	if (profile) {
		providerConfig.profile = profile;
	}
	if (sandbox) {
		providerConfig.sandbox = sandbox;
	}
	if (skipGitRepoCheck !== undefined) {
		providerConfig.skipGitRepoCheck = skipGitRepoCheck;
	}
	if (fullAuto !== undefined) {
		providerConfig.fullAuto = fullAuto;
	}
	if (timeoutMs !== undefined) {
		providerConfig.timeoutMs = timeoutMs;
	}

	return {
		model,
		providerConfig,
	};
}

function resolveOpenCodeEnvConfig(env: EnvSource) {
	const providerConfig: Record<string, unknown> = {};
	const command = normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCODE_COMMAND);
	const agent = normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCODE_AGENT);
	const model = normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCODE_MODEL);
	const timeoutMs = parsePositiveIntegerEnv(env, "OPENCONTEXT_AGENT_OPENCODE_TIMEOUT_MS");
	const allowAutoApprove = parseBooleanEnv(env, "OPENCONTEXT_AGENT_OPENCODE_ALLOW_AUTO_APPROVE");

	if (command) {
		providerConfig.opencodePath = command;
	}
	if (agent) {
		providerConfig.agent = agent;
	}
	if (timeoutMs !== undefined) {
		providerConfig.timeoutMs = timeoutMs;
	}
	if (allowAutoApprove !== undefined) {
		providerConfig.allowAutoApprove = allowAutoApprove;
	}

	return {
		model,
		providerConfig,
	};
}

function resolveOpenClawEnvConfig(env: EnvSource) {
	const providerConfig: Record<string, unknown> = {};
	const values = {
		openclawPath: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_COMMAND),
		gatewayUrl: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_GATEWAY_URL),
		tokenFile: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_TOKEN_FILE),
		passwordFile: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_PASSWORD_FILE),
		session: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_SESSION),
		sessionLabel: normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_SESSION_LABEL),
	};

	if (values.session && values.sessionLabel) {
		throwConfigError(
			"OPENCONTEXT_AGENT_OPENCLAW_SESSION and OPENCONTEXT_AGENT_OPENCLAW_SESSION_LABEL are mutually exclusive.",
		);
	}
	if (values.gatewayUrl && !isWebSocketUrl(values.gatewayUrl)) {
		throwConfigError(
			`OPENCONTEXT_AGENT_OPENCLAW_GATEWAY_URL must use ws: or wss:. Received: ${values.gatewayUrl}.`,
		);
	}

	for (const [key, value] of Object.entries(values)) {
		if (value) providerConfig[key] = value;
	}

	const booleanOptions = [
		["requireExisting", "OPENCONTEXT_AGENT_OPENCLAW_REQUIRE_EXISTING"],
		["resetSession", "OPENCONTEXT_AGENT_OPENCLAW_RESET_SESSION"],
		["noPrefixCwd", "OPENCONTEXT_AGENT_OPENCLAW_NO_PREFIX_CWD"],
	] as const;
	for (const [configKey, envKey] of booleanOptions) {
		const value = parseBooleanEnv(env, envKey);
		if (value !== undefined) providerConfig[configKey] = value;
	}

	if (providerConfig.requireExisting === true && !values.session && !values.sessionLabel) {
		throwConfigError(
			"OPENCONTEXT_AGENT_OPENCLAW_REQUIRE_EXISTING requires OPENCONTEXT_AGENT_OPENCLAW_SESSION or OPENCONTEXT_AGENT_OPENCLAW_SESSION_LABEL.",
		);
	}

	const provenance = normalizeOptionalString(env.OPENCONTEXT_AGENT_OPENCLAW_PROVENANCE);
	if (provenance && provenance !== "off" && provenance !== "meta" && provenance !== "meta+receipt") {
		throwConfigError(
			`OPENCONTEXT_AGENT_OPENCLAW_PROVENANCE must be off, meta, or meta+receipt. Received: ${provenance}.`,
		);
	}
	if (provenance) providerConfig.provenance = provenance;

	const timeoutMs = parsePositiveIntegerEnv(env, "OPENCONTEXT_AGENT_OPENCLAW_TIMEOUT_MS");
	if (timeoutMs !== undefined) providerConfig.timeoutMs = timeoutMs;

	return providerConfig;
}

function parseBooleanEnv(env: EnvSource, key: string): boolean | undefined {
	const raw = normalizeOptionalString(env[key]);
	if (!raw) {
		return undefined;
	}

	switch (raw.toLowerCase()) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		default:
			throwConfigError(`${key} must be one of true, false, 1, or 0. Received: ${raw}.`);
	}
}

function parsePositiveIntegerEnv(env: EnvSource, key: string): number | undefined {
	const raw = normalizeOptionalString(env[key]);
	if (!raw) {
		return undefined;
	}

	if (!/^\d+$/.test(raw)) {
		throwConfigError(`${key} must be a positive integer. Received: ${raw}.`);
	}

	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throwConfigError(`${key} must be a positive integer. Received: ${raw}.`);
	}

	return parsed;
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed || undefined;
}

function isWebSocketUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "ws:" || url.protocol === "wss:";
	} catch {
		return false;
	}
}

function throwConfigError(message: string): never {
	throw new NativeAgentRequestError(message, 500);
}
