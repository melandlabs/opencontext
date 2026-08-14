/**
 * Config schema for dsh-opencontext.
 *
 * Resolved precedence (highest first):
 *   1. `cordis.patch.yml` row under `id: dsh-opencontext` (config block).
 *   2. `OPENCONTEXT_DSH_*` environment variables.
 *   3. Defaults declared in the schemastery schema below.
 *
 * Env→field mapping:
 *   OPENCONTEXT_DSH_BASE_URL         → baseUrl
 *   OPENCONTEXT_DSH_AUTHORIZATION    → authorization (full `Bearer <token>`)
 *   OPENCONTEXT_DSH_SCOPE_ID         → scopeId
 *   OPENCONTEXT_DSH_CAPTURE_PROMPTS  → capturePrompts (`1` / `0`)
 *   OPENCONTEXT_DSH_FLUSH_ON_CAPTURE → flushOnCapture (`1` / `0`)
 *   OPENCONTEXT_DSH_MAX_BYTES        → maxBytes
 *   OPENCONTEXT_DSH_MAX_RECALL_ITEMS → maxRecallItems
 *   OPENCONTEXT_DSH_TIMEOUT_MS       → timeoutMs
 *   OPENCONTEXT_DSH_REQUEST_TIMEOUT  → requestTimeoutMs
 *
 *   OPENCONTEXT_DSH_HTTP_URL (presence-only) flips the backend to HTTP mode.
 *   OPENCONTEXT_MEMORY_STORE_DB_PATH controls the SQLite path used by the
 *   lib backend; the plugin does not re-read it directly but documents it.
 */

import z from "@deepseek-ai/schemastery";
import type { Schema } from "@deepseek-ai/schemastery";

export const ConfigSchema: Schema<ResolvedConfig> = z.object({
	baseUrl: z.string().default("http://127.0.0.1:8000"),
	authorization: z.string().default(""),
	scopeId: z.string().default(""),
	timeoutMs: z.number().default(4000),
	requestTimeoutMs: z.number().default(1000),
	maxBytes: z.number().default(8000),
	capturePrompts: z.boolean().default(true),
	flushOnCapture: z.boolean().default(false),
	maxRecallItems: z.number().default(8),
}) as unknown as Schema<ResolvedConfig>;

export interface ResolvedConfig {
	baseUrl: string;
	authorization: string;
	scopeId: string;
	timeoutMs: number;
	requestTimeoutMs: number;
	maxBytes: number;
	capturePrompts: boolean;
	flushOnCapture: boolean;
	maxRecallItems: number;
}

function envString(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function envNumber(name: string): number | undefined {
	const raw = envString(name);
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function envBool(name: string): boolean | undefined {
	const raw = envString(name);
	if (raw === undefined) return undefined;
	const lowered = raw.toLowerCase();
	if (lowered === "1" || lowered === "true" || lowered === "yes") return true;
	if (lowered === "0" || lowered === "false" || lowered === "no") return false;
	return undefined;
}

export function resolveConfig(patchConfig: Partial<ResolvedConfig> | undefined): ResolvedConfig {
	const fromEnv: Partial<ResolvedConfig> = {};
	const envBase = envString("OPENCONTEXT_DSH_BASE_URL");
	if (envBase !== undefined) fromEnv.baseUrl = envBase;
	const envAuth = envString("OPENCONTEXT_DSH_AUTHORIZATION");
	if (envAuth !== undefined) fromEnv.authorization = envAuth;
	const envScope = envString("OPENCONTEXT_DSH_SCOPE_ID");
	if (envScope !== undefined) fromEnv.scopeId = envScope;
	const envCapture = envBool("OPENCONTEXT_DSH_CAPTURE_PROMPTS");
	if (envCapture !== undefined) fromEnv.capturePrompts = envCapture;
	const envFlush = envBool("OPENCONTEXT_DSH_FLUSH_ON_CAPTURE");
	if (envFlush !== undefined) fromEnv.flushOnCapture = envFlush;
	const envMaxBytes = envNumber("OPENCONTEXT_DSH_MAX_BYTES");
	if (envMaxBytes !== undefined) fromEnv.maxBytes = envMaxBytes;
	const envMaxRecall = envNumber("OPENCONTEXT_DSH_MAX_RECALL_ITEMS");
	if (envMaxRecall !== undefined) fromEnv.maxRecallItems = envMaxRecall;
	const envTimeout = envNumber("OPENCONTEXT_DSH_TIMEOUT_MS");
	if (envTimeout !== undefined) fromEnv.timeoutMs = envTimeout;
	const envRequestTimeout = envNumber("OPENCONTEXT_DSH_REQUEST_TIMEOUT");
	if (envRequestTimeout !== undefined) fromEnv.requestTimeoutMs = envRequestTimeout;

	const merged: ResolvedConfig = {
		baseUrl: fromEnv.baseUrl ?? patchConfig?.baseUrl ?? "http://127.0.0.1:8000",
		authorization: fromEnv.authorization ?? patchConfig?.authorization ?? "",
		scopeId: fromEnv.scopeId ?? patchConfig?.scopeId ?? "",
		timeoutMs: fromEnv.timeoutMs ?? patchConfig?.timeoutMs ?? 4000,
		requestTimeoutMs: fromEnv.requestTimeoutMs ?? patchConfig?.requestTimeoutMs ?? 1000,
		maxBytes: fromEnv.maxBytes ?? patchConfig?.maxBytes ?? 8000,
		capturePrompts: fromEnv.capturePrompts ?? patchConfig?.capturePrompts ?? true,
		flushOnCapture: fromEnv.flushOnCapture ?? patchConfig?.flushOnCapture ?? false,
		maxRecallItems: fromEnv.maxRecallItems ?? patchConfig?.maxRecallItems ?? 8,
	};
	return merged;
}

export function isHttpMode(): boolean {
	return envString("OPENCONTEXT_DSH_HTTP_URL") !== undefined;
}
