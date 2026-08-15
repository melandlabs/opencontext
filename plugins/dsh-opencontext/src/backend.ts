/**
 * OpenContextBackend — the abstract surface that tools, recall, and
 * capture call into. Two concrete implementations exist: `LibBackend`
 * (in-process, calls `@melandlabs/opencontext` directly) and
 * `HttpBackend` (POST against an external OpenContext daemon).
 *
 * The two modes are deliberately shape-compatible so tools and listeners
 * never need to know which one is active.
 */

import type { ResolvedConfig } from "./config.js";
import { createLibBackend, type LibBackend } from "./backend-lib.js";
import { createHttpBackend, type HttpBackend } from "./backend-http.js";
import { isHttpMode } from "./config.js";

export interface SearchInput {
	query: string;
	limit?: number;
	threshold?: number;
	scopeId?: string;
	userId?: string;
}

export interface SearchHit {
	id: string;
	content: string;
	score: number;
	timestamp?: number;
	metadata?: Record<string, unknown>;
}

export interface RememberInput {
	content: string;
	sourceType?: string;
	metadata?: Record<string, unknown>;
	scopeId?: string;
	userId?: string;
	botId?: string;
}

export interface ListInput {
	limit?: number;
	since?: number;
	scopeId?: string;
	userId?: string;
}

export interface MemoryItem {
	id: string;
	content: string;
	timestamp?: number;
	metadata?: Record<string, unknown>;
	platform?: string;
	botId?: string;
}

export interface ReviseInput {
	id: string;
	content: string;
	reason?: string;
	metadata?: Record<string, unknown>;
	scopeId?: string;
	userId?: string;
	botId?: string;
}

export interface CaptureInput {
	content: string;
	sourceType?: string;
	metadata?: Record<string, unknown>;
	scopeId?: string;
	userId?: string;
	botId?: string;
}

export interface RevokeResult {
	deprecatedId: string;
	newId: string;
}

export interface BackendCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface OpenContextBackend {
	readonly mode: "lib" | "http";
	search(input: SearchInput, opts?: BackendCallOptions): Promise<SearchHit[]>;
	remember(
		input: RememberInput,
		opts?: BackendCallOptions
	): Promise<{ ids: string[] }>;
	list(input: ListInput, opts?: BackendCallOptions): Promise<MemoryItem[]>;
	get(
		input: { ids: string[]; scopeId?: string; userId?: string },
		opts?: BackendCallOptions
	): Promise<MemoryItem[]>;
	revise(input: ReviseInput, opts?: BackendCallOptions): Promise<RevokeResult>;
	retire(
		input: { id: string; reason?: string; scopeId?: string; userId?: string },
		opts?: BackendCallOptions
	): Promise<{ ok: true }>;
	captureSource(
		input: CaptureInput,
		opts?: BackendCallOptions
	): Promise<{ id: string }>;
	health(): Promise<{ ok: boolean; mode: "lib" | "http"; details?: string }>;
	dispose?(): Promise<void>;
}

export type AnyBackend = LibBackend | HttpBackend;

export function createBackend(config: ResolvedConfig): OpenContextBackend {
	if (isHttpMode()) {
		return createHttpBackend(config);
	}
	return createLibBackend(config);
}
