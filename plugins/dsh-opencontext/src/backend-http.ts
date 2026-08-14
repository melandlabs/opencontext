/**
 * HttpBackend — `fetch()`-based implementation of OpenContextBackend.
 *
 * Activated when `OPENCONTEXT_DSH_HTTP_URL` is set. Targets the same
 * request shapes that the upstream `powercontext-dsh` plugin emits
 * against its context server, with paths prefixed `/v1/memory/*` and
 * `/v1/context/*`. This mode is forward-looking: the v0.1.x OpenContext
 * daemon does not yet expose these endpoints, so requests will fail
 * with structured `backend_unavailable` / `version_mismatch` errors
 * until a compatible server ships. Lib mode is the supported path on
 * day one.
 */

import { constants, classifyBackendError, type ErrorCode } from "./errors";
import { redactSecrets } from "./secrets";
import type { ResolvedConfig } from "./config";
import type {
	BackendCallOptions,
	CaptureInput,
	ListInput,
	MemoryItem,
	OpenContextBackend,
	RememberInput,
	ReviseInput,
	RevokeResult,
	SearchHit,
	SearchInput,
} from "./backend";

export interface HttpBackend extends OpenContextBackend {
	readonly mode: "http";
}

interface FetchResponse {
	ok: boolean;
	status: number;
	body: unknown;
	raw: Response;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<T> {
	const timeoutSignal = !signal && timeoutMs ? AbortSignal.timeout(timeoutMs) : signal;
	if (timeoutSignal && !signal) {
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`request timed out after ${timeoutMs}ms`));
			}, timeoutMs ?? 30_000);
			timeoutSignal.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new Error("request aborted"));
			});
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}
	if (signal) {
		return await new Promise<T>((resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("request aborted")));
			promise.then(resolve, reject);
		});
	}
	return await promise;
}

function joinUrl(base: string, path: string): string {
	const trimmed = base.replace(/\/+$/, "");
	const prefixed = path.startsWith("/") ? path : `/${path}`;
	return `${trimmed}${prefixed}`;
}

class HttpClientError extends Error {
	readonly statusCode: number;
	readonly code: ErrorCode;
	readonly payload: unknown;
	constructor(statusCode: number, code: ErrorCode, message: string, payload: unknown) {
		super(message);
		this.name = "HttpClientError";
		this.statusCode = statusCode;
		this.code = code;
		this.payload = payload;
	}
}

export function createHttpBackend(config: ResolvedConfig): HttpBackend {
	const baseUrl = process.env.OPENCONTEXT_DSH_HTTP_URL?.trim() || config.baseUrl;
	const auth = (process.env.OPENCONTEXT_DSH_AUTHORIZATION ?? config.authorization ?? "").trim();

	async function request<T = unknown>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: unknown,
		opts?: BackendCallOptions,
	): Promise<T> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": `${constants.PLUGIN_NAME}/0.1.0`,
		};
		if (auth) headers.Authorization = auth;

		const url = joinUrl(baseUrl, path);
		const controller = new AbortController();
		const fetchPromise = fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
		let response: Response;
		try {
			response = await withTimeout(fetchPromise, opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
		} catch (error) {
			const cls = classifyBackendError(error);
			throw new HttpClientError(cls.statusCode ?? 0, cls.code, cls.message, null);
		}
		const text = await response.text();
		let json: unknown = null;
		if (text) {
			try {
				json = JSON.parse(text);
			} catch {
				json = text;
			}
		}
		if (!response.ok) {
			const cls = classifyBackendError({ statusCode: response.status, message: redactSecrets(text) });
			throw new HttpClientError(response.status, cls.code, cls.message, json);
		}
		return json as T;
	}

	function scopeIdOf(input: { scopeId?: string }): string {
		return input.scopeId || config.scopeId || "local:unknown";
	}

	async function search(input: SearchInput, opts?: BackendCallOptions): Promise<SearchHit[]> {
		const scopeId = scopeIdOf(input);
		const payload = {
			scope_id: scopeId,
			query: input.query,
			limit: Math.max(1, Math.min(50, input.limit ?? config.maxRecallItems)),
			mode: "auto",
		};
		const res = await request<{
			results?: Array<{
				id: string;
				content: string;
				score: number;
				metadata?: Record<string, unknown>;
				timestamp?: number;
			}>;
		}>("POST", "/v1/memory/search", payload, opts);
		return (res.results ?? []).map((hit) => ({
			id: hit.id,
			content: hit.content,
			score: hit.score,
			timestamp: hit.timestamp,
			metadata: hit.metadata,
		}));
	}

	async function remember(input: RememberInput, opts?: BackendCallOptions): Promise<{ ids: string[] }> {
		const scopeId = scopeIdOf(input);
		const payload = {
			scope_id: scopeId,
			kind: (input.metadata?.kind as string) ?? "agent-note",
			text: input.content,
			reason: input.metadata?.reason as string | undefined,
		};
		const res = await request<{ ids?: string[] }>("POST", "/v1/memory/remember", payload, opts);
		return { ids: res.ids ?? [] };
	}

	async function list(input: ListInput, opts?: BackendCallOptions): Promise<MemoryItem[]> {
		const scopeId = scopeIdOf(input);
		const payload = {
			scope_id: scopeId,
			limit: Math.max(1, Math.min(500, input.limit ?? 50)),
			since: input.since,
		};
		const res = await request<{ items?: MemoryItem[] }>("POST", "/v1/memory/list", payload, opts);
		return res.items ?? [];
	}

	async function get(
		input: { ids: string[]; scopeId?: string },
		opts?: BackendCallOptions,
	): Promise<MemoryItem[]> {
		const scopeId = scopeIdOf(input);
		const payload = { scope_id: scopeId, ids: input.ids };
		const res = await request<{ items?: MemoryItem[] }>("POST", "/v1/memory/get", payload, opts);
		return res.items ?? [];
	}

	async function revise(input: ReviseInput, opts?: BackendCallOptions): Promise<RevokeResult> {
		const scopeId = scopeIdOf(input);
		const payload = {
			scope_id: scopeId,
			citation: input.id,
			kind: (input.metadata?.kind as string) ?? "agent-note",
			text: input.content,
			reason: input.reason,
		};
		const res = await request<{ deprecatedId?: string; newId?: string }>(
			"POST",
			"/v1/memory/revise",
			payload,
			opts,
		);
		return { deprecatedId: res.deprecatedId ?? input.id, newId: res.newId ?? input.id };
	}

	async function retire(
		input: { id: string; reason?: string; scopeId?: string },
		opts?: BackendCallOptions,
	): Promise<{ ok: true }> {
		const scopeId = scopeIdOf(input);
		const payload = { scope_id: scopeId, citation: input.id, reason: input.reason };
		await request<unknown>("POST", "/v1/memory/retire", payload, opts);
		return { ok: true };
	}

	async function captureSource(input: CaptureInput, opts?: BackendCallOptions): Promise<{ id: string }> {
		const scopeId = scopeIdOf(input);
		const payload = {
			scope_id: scopeId,
			source_id: input.metadata?.sourceId as string | undefined,
			content: input.content,
			metadata: { origin: "dsh", sourceType: input.sourceType, ...(input.metadata ?? {}) },
		};
		const res = await request<{ id: string }>("POST", "/v1/memory/capture_source", payload, opts);
		return { id: res.id };
	}

	async function health(): Promise<{ ok: boolean; mode: "http"; details?: string }> {
		try {
			const controller = new AbortController();
			const fetchPromise = fetch(joinUrl(baseUrl, "/health/live"), {
				method: "GET",
				headers: auth ? { Authorization: auth } : {},
				signal: controller.signal,
			});
			const response = await withTimeout(fetchPromise, Math.min(config.timeoutMs, 2000), undefined);
			return {
				ok: response.ok,
				mode: "http",
				details: `url=${baseUrl} status=${response.status}`,
			};
		} catch (error) {
			return {
				ok: false,
				mode: "http",
				details: (error as Error).message ?? "unknown error",
			};
		}
	}

	return {
		mode: "http",
		search,
		remember,
		list,
		get,
		revise,
		retire,
		captureSource,
		health,
	};
}
