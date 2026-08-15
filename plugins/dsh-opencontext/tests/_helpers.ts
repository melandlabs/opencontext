/**
 * Test-only helpers for faking the opencontext runtime.
 *
 * These intentionally do NOT import the real `@melandlabs/opencontext`
 * package — the plugin's lib backend uses dynamic imports that we
 * stub in each test by reassigning the relevant module exports.
 */

import { vi } from "vitest";

import type {
	OpenContextBackend,
	SearchHit,
	MemoryItem,
} from "../src/backend.js";
import type { ResolvedConfig } from "../src/config.js";

export function makeConfig(
	overrides: Partial<ResolvedConfig> = {}
): ResolvedConfig {
	return {
		baseUrl: "http://127.0.0.1:8000",
		authorization: "",
		scopeId: "test:scope",
		timeoutMs: 1000,
		requestTimeoutMs: 500,
		maxBytes: 4096,
		capturePrompts: true,
		flushOnCapture: false,
		maxRecallItems: 4,
		...overrides,
	};
}

export function makeSearchHit(over: Partial<SearchHit> = {}): SearchHit {
	return {
		id: "hit-1",
		content: "lorem ipsum",
		score: 0.9,
		timestamp: 1_700_000_000_000,
		metadata: { origin: "dsh" },
		...over,
	};
}

export function makeMemoryItem(over: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id: "msg-1",
		content: "stored content",
		timestamp: 1_700_000_000_000,
		metadata: { origin: "dsh" },
		platform: "dsh",
		botId: "dsh",
		...over,
	};
}

export function makeFakeBackend(
	over: Partial<OpenContextBackend> = {}
): OpenContextBackend {
	return {
		mode: "lib",
		search: vi.fn(async () => []),
		remember: vi.fn(async () => ({ ids: ["msg-1"] })),
		list: vi.fn(async () => []),
		get: vi.fn(async () => []),
		revise: vi.fn(async () => ({ deprecatedId: "old", newId: "new" })),
		retire: vi.fn(async () => ({ ok: true as const })),
		captureSource: vi.fn(async () => ({ id: "msg-1" })),
		health: vi.fn(async () => ({
			ok: true,
			mode: "lib" as const,
			details: "ok",
		})),
		...over,
	};
}
