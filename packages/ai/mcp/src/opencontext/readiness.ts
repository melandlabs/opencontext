import { DEFAULT_OPENCONTEXT_BASE_URLS, OpenContextApiError, OpenContextClient } from "./client";
import { type OpenContextAuthToken, readOpenContextAuthToken } from "./token";

export const OPENCONTEXT_INSTALL_URL = "https://opencontext.ai/docs/getting-started";

export type OpenContextReadinessState =
	| "READY"
	| "DESKTOP_NOT_DETECTED"
	| "TOKEN_REQUIRED"
	| "AUTH_FAILED"
	| "API_ERROR";

export interface OpenContextApiProbe {
	baseUrl: string;
	reachable: boolean;
	status?: number;
	authOk: boolean;
	error?: string;
}

export interface OpenContextReadiness {
	ready: boolean;
	state: OpenContextReadinessState;
	baseUrl: string | null;
	installUrl: string;
	token: {
		present: boolean;
		source: OpenContextAuthToken["source"];
		path?: string;
		error?: string;
	};
	api: {
		reachable: boolean;
		selectedBaseUrl: string | null;
		probes: OpenContextApiProbe[];
	};
	auth: {
		ok: boolean;
		status?: number;
		error?: string;
	};
	nextSteps: string[];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function getCandidateBaseUrls(preferredBaseUrl?: string): string[] {
	return uniqueStrings([preferredBaseUrl, process.env.OPENCONTEXT_API_URL, ...DEFAULT_OPENCONTEXT_BASE_URLS]);
}

async function probeOpenContextApi(input: {
	baseUrl: string;
	token: string | null;
	timeoutMs: number;
}): Promise<OpenContextApiProbe> {
	const client = new OpenContextClient({
		baseUrl: input.baseUrl,
		token: input.token ?? undefined,
		timeoutMs: input.timeoutMs,
	});

	try {
		await client.getJson("/api/remote-auth/user", {
			token: input.token,
			timeoutMs: input.timeoutMs,
		});
		return {
			baseUrl: client.baseUrl,
			reachable: true,
			status: 200,
			authOk: Boolean(input.token),
		};
	} catch (error) {
		if (error instanceof OpenContextApiError) {
			return {
				baseUrl: client.baseUrl,
				reachable: true,
				status: error.status,
				authOk: false,
				error: error.message,
			};
		}

		return {
			baseUrl: client.baseUrl,
			reachable: false,
			authOk: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function resolveReadinessState(input: {
	tokenPresent: boolean;
	selectedProbe: OpenContextApiProbe | null;
}): OpenContextReadinessState {
	const { tokenPresent, selectedProbe } = input;

	if (!selectedProbe) {
		return "DESKTOP_NOT_DETECTED";
	}

	if (!tokenPresent) {
		return "TOKEN_REQUIRED";
	}

	if (selectedProbe.authOk) {
		return "READY";
	}

	if (selectedProbe.status === 401 || selectedProbe.status === 403) {
		return "AUTH_FAILED";
	}

	return "API_ERROR";
}

function getNextSteps(state: OpenContextReadinessState): string[] {
	switch (state) {
		case "READY":
			return [
				"OpenContext Desktop is running and token authentication passed.",
				"You can now use OpenContext MCP tools from this agent runtime.",
			];
		case "DESKTOP_NOT_DETECTED":
			return [
				`Install OpenContext Desktop from ${OPENCONTEXT_INSTALL_URL} if it is not installed.`,
				"Start OpenContext Desktop and keep it running.",
				"Run opencontext_setup again after the app is running.",
			];
		case "TOKEN_REQUIRED":
			return [
				"Open OpenContext Desktop and complete sign-in or guest setup.",
				"Wait for ~/.opencontext/token to be created, or set OPENCONTEXT_AUTH_TOKEN.",
				"Run opencontext_setup again after the token is available.",
			];
		case "AUTH_FAILED":
			return [
				"Open OpenContext Desktop and refresh the current session.",
				"If OPENCONTEXT_AUTH_TOKEN is set, verify it is the current token.",
				"Run opencontext_setup again after re-authentication.",
			];
		case "API_ERROR":
			return [
				"OpenContext Desktop responded, but the readiness probe did not complete cleanly.",
				"Restart OpenContext Desktop and run opencontext_setup again.",
			];
	}
}

export async function checkOpenContextReadiness(
	options: {
		authToken?: OpenContextAuthToken;
		preferredBaseUrl?: string;
		token?: string;
		timeoutMs?: number;
	} = {},
): Promise<OpenContextReadiness> {
	const tokenResult =
		options.authToken ??
		(options.token
			? ({ token: options.token, source: "env" } satisfies OpenContextAuthToken)
			: await readOpenContextAuthToken());
	const token = tokenResult.token ?? null;
	const probes = await Promise.all(
		getCandidateBaseUrls(options.preferredBaseUrl).map((baseUrl) =>
			probeOpenContextApi({
				baseUrl,
				token,
				timeoutMs: options.timeoutMs ?? 1500,
			}),
		),
	);
	const selectedProbe =
		probes.find((probe) => probe.authOk) ?? probes.find((probe) => probe.reachable) ?? null;
	const state = resolveReadinessState({
		tokenPresent: Boolean(token),
		selectedProbe,
	});

	return {
		ready: state === "READY",
		state,
		baseUrl: selectedProbe?.baseUrl ?? null,
		installUrl: OPENCONTEXT_INSTALL_URL,
		token: {
			present: Boolean(token),
			source: tokenResult.source,
			path: tokenResult.path,
			error: tokenResult.error,
		},
		api: {
			reachable: Boolean(selectedProbe),
			selectedBaseUrl: selectedProbe?.baseUrl ?? null,
			probes,
		},
		auth: {
			ok: state === "READY",
			status: selectedProbe?.status,
			error: selectedProbe?.error,
		},
		nextSteps: getNextSteps(state),
	};
}

export function formatOpenContextReadiness(readiness: OpenContextReadiness): string {
	const lines = [
		`OpenContext MCP readiness: ${readiness.state}`,
		`Desktop API: ${
			readiness.api.reachable ? `reachable at ${readiness.api.selectedBaseUrl}` : "not detected"
		}`,
		`Token: ${readiness.token.present ? `found via ${readiness.token.source}` : "missing"}`,
		`Auth: ${readiness.auth.ok ? "passed" : "not ready"}`,
		"",
		"Next steps:",
		...readiness.nextSteps.map((step) => `- ${step}`),
	];

	return lines.join("\n");
}
