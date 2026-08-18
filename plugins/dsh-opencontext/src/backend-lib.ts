/**
 * LibBackend — in-process implementation of OpenContextBackend.
 *
 * Calls `@melandlabs/opencontext` directly:
 *   - `createUnifiedSearch().search` for search
 *   - `getRawMessageManager().storeMessages` / `queryMessages` /
 *     `getMessageById` / `deprecateMessages` for memory CRUD
 *
 * The backend is initialised lazily on first call. The unified search
 * requires an embedding provider; when none is configured the search
 * falls back to the raw-message lexical search so the plugin still
 * returns something useful out of the box.
 */

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { getOpenContextPath } from "@melandlabs/env-config";
import { getRawMessageManager, isRawMessageStorageAvailable } from "@melandlabs/opencontext";

import type {
	BackendCallOptions,
	CaptureInput,
	ListInput,
	MemoryItem,
	OpenContextBackend,
	RememberInput,
	ReviseInput,
	SearchHit,
	SearchInput,
	UploadDocumentInput,
	SearchKnowledgeInput,
	ListDocumentsInput,
	SearchInsightsInput,
	CaptureInsightInput,
} from "./backend.js";
import type { ResolvedConfig } from "./config.js";
import { LibKnowledgeStore, KnowledgeUnavailableError } from "./knowledge-store.js";

interface RawManager {
	storeMessages(messages: unknown[]): Promise<number[]>;
	queryMessages(query: unknown): Promise<unknown[]>;
	getMessageById(messageId: string): Promise<unknown | null>;
	getStats?(): Promise<{ totalMessages: number }>;
	deprecateMessages?(
		messageIds: string[],
		input: { reason?: string; deprecatedAt?: number; userId?: string },
	): Promise<number>;
}

interface UnifiedSearchLike {
	search(input: {
		userId: string;
		query: string;
		limit?: number;
		threshold?: number;
		sources?: string[];
	}): Promise<{
		results: Array<{
			id: string;
			content: string;
			similarity: number;
			metadata: Record<string, unknown>;
		}>;
		warnings: Array<{ source: string; code: string; message: string }>;
	}>;
}

let _createUnifiedSearch: ((deps?: unknown) => UnifiedSearchLike) | null = null;
let _createUnifiedSearchProbed = false;

async function getUnifiedSearch(): Promise<UnifiedSearchLike | undefined> {
	if (!_createUnifiedSearchProbed) {
		_createUnifiedSearchProbed = true;
		try {
			const mod = await import("@melandlabs/opencontext");
			const factory = (
				mod as unknown as {
					createUnifiedSearch?: (deps?: unknown) => UnifiedSearchLike;
				}
			).createUnifiedSearch;
			if (typeof factory === "function") {
				_createUnifiedSearch = factory as (deps?: unknown) => UnifiedSearchLike;
			}
		} catch {
			_createUnifiedSearch = null;
		}
	}
	return _createUnifiedSearch ? _createUnifiedSearch() : undefined;
}

export interface LibBackend extends OpenContextBackend {
	readonly mode: "lib";
}

const DEFAULT_BOT_ID = "dsh";

function makeIdempotentId(seed: string): string {
	return `dsh-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function nowMs(): number {
	return Date.now();
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<T> {
	const effectiveSignal = signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
	if (!effectiveSignal) return promise;
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`operation timed out after ${timeoutMs}ms`));
		}, timeoutMs ?? 30_000);
		effectiveSignal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("operation aborted"));
		});
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function asMemoryItem(raw: unknown): MemoryItem {
	const r = raw as {
		messageId?: string;
		id?: string;
		content?: string;
		timestamp?: number;
		metadata?: Record<string, unknown>;
		platform?: string;
		botId?: string;
	};
	return {
		id: r.messageId ?? r.id ?? "",
		content: r.content ?? "",
		timestamp: typeof r.timestamp === "number" ? r.timestamp : undefined,
		metadata: r.metadata,
		platform: r.platform,
		botId: r.botId,
	};
}

export function createLibBackend(config: ResolvedConfig): LibBackend {
	let initPromise:
		| Promise<{
				manager: RawManager;
				search: UnifiedSearchLike | undefined;
				ready: boolean;
		  }>
		| undefined;

	async function ensureInit(): Promise<{
		manager: RawManager;
		search: UnifiedSearchLike | undefined;
		ready: boolean;
	}> {
		if (initPromise) return initPromise;
		initPromise = (async () => {
			const ready = isRawMessageStorageAvailable();
			const manager = (await getRawMessageManager()) as unknown as RawManager;
			const search = await getUnifiedSearch();
			return { manager, search, ready };
		})();
		return initPromise;
	}

	const resolveUser = (override?: string): string => override || config.scopeId || "dsh-default";
	const resolveBot = (override?: string): string => override || DEFAULT_BOT_ID;

	let knowledgeStore: LibKnowledgeStore | null = null;
	function getKnowledgeStore(): LibKnowledgeStore {
		if (!knowledgeStore) {
			knowledgeStore = new LibKnowledgeStore({});
		}
		return knowledgeStore;
	}

	async function search(input: SearchInput, opts?: BackendCallOptions): Promise<SearchHit[]> {
		const { manager, search, ready } = await ensureInit();
		if (!ready) return [];
		const userId = resolveUser(input.userId);
		const limit = Math.max(1, Math.min(50, input.limit ?? config.maxRecallItems));
		const threshold = typeof input.threshold === "number" ? input.threshold : 0.5;
		const query = input.query.trim();
		if (!query) return [];

		if (search) {
			try {
				const result = await withTimeout(
					search.search({ userId, query, limit, threshold }),
					opts?.timeoutMs ?? config.timeoutMs,
					opts?.signal,
				);
				const hits: SearchHit[] = [];
				for (const r of result.results ?? []) {
					const ts = typeof r.metadata?.timestamp === "number" ? (r.metadata.timestamp as number) : undefined;
					hits.push({
						id: r.id,
						content: r.content,
						score: r.similarity,
						timestamp: ts,
						metadata: r.metadata,
					});
				}
				// If the unified search surfaced no hits, fall through to the
				// lexical raw-message search so the plugin still returns
				// something useful out of the box.
				if (hits.length > 0) {
					return hits;
				}
			} catch {
				// Fall through to lexical search below.
			}
		}

		// Fallback: lexical search via the raw-message manager.
		const keywords = query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length >= 2)
			.slice(0, 16);
		if (keywords.length === 0) return [];
		const records = await manager.queryMessages({
			userId,
			platform: "dsh",
			keywords,
			limit,
		});
		return (records ?? []).map((record) => {
			const item = asMemoryItem(record);
			return {
				id: item.id,
				content: item.content,
				score: 0.5,
				timestamp: item.timestamp,
				metadata: item.metadata ?? {},
			};
		});
	}

	async function remember(input: RememberInput, opts?: BackendCallOptions): Promise<{ ids: string[] }> {
		const { manager, ready } = await ensureInit();
		if (!ready) throw new Error("raw message storage is not available in this environment");
		const userId = resolveUser(input.userId);
		const botId = resolveBot(input.botId);
		const ts = nowMs();
		const messageId = makeIdempotentId(`${userId}|${botId}|${ts}|${input.content.slice(0, 256)}`);
		const record = {
			messageId,
			platform: "dsh",
			botId,
			userId,
			channel: input.metadata?.channel as string | undefined,
			timestamp: ts,
			content: input.content,
			metadata: {
				...(input.metadata ?? {}),
				sourceType: input.sourceType ?? "user_request",
				origin: "dsh-opencontext",
			},
			createdAt: ts,
		};
		await withTimeout(manager.storeMessages([record]), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
		// `storeMessages` returns the autoincrement rowid; the public ID we
		// expose to the rest of the plugin is the `message_id` we constructed
		// (which is what `getMessageById` actually keys on).
		return { ids: [messageId] };
	}

	async function list(input: ListInput, opts?: BackendCallOptions): Promise<MemoryItem[]> {
		const { manager, ready } = await ensureInit();
		if (!ready) return [];
		const userId = resolveUser(input.userId);
		const records = await withTimeout(
			manager.queryMessages({
				userId,
				platform: "dsh",
				limit: Math.max(1, Math.min(500, input.limit ?? 50)),
				startTime: input.since,
				reverse: true,
			}),
			opts?.timeoutMs ?? config.timeoutMs,
			opts?.signal,
		);
		return (records ?? []).map(asMemoryItem);
	}

	async function get(
		input: { ids: string[]; scopeId?: string; userId?: string },
		opts?: BackendCallOptions,
	): Promise<MemoryItem[]> {
		const { manager, ready } = await ensureInit();
		if (!ready) return [];
		const results: MemoryItem[] = [];
		for (const id of input.ids) {
			try {
				const raw = await withTimeout(
					manager.getMessageById(id),
					opts?.timeoutMs ?? config.timeoutMs,
					opts?.signal,
				);
				if (raw) results.push(asMemoryItem(raw));
			} catch {
				// Skip ids that fail to resolve; the tool caller will see them absent.
			}
		}
		return results;
	}

	async function revise(
		input: ReviseInput,
		opts?: BackendCallOptions,
	): Promise<{ deprecatedId: string; newId: string }> {
		const { manager, ready } = await ensureInit();
		if (!ready) throw new Error("raw message storage is not available in this environment");
		const userId = resolveUser(input.userId);
		const botId = resolveBot(input.botId);
		if (typeof manager.deprecateMessages === "function") {
			await withTimeout(
				manager.deprecateMessages([input.id], {
					reason: input.reason ?? "revised",
					deprecatedAt: nowMs(),
					userId,
				}),
				opts?.timeoutMs ?? config.timeoutMs,
				opts?.signal,
			);
		}
		const stored = await remember(
			{
				content: input.content,
				metadata: {
					supersedes: input.id,
					reason: input.reason,
				},
				userId,
				botId,
			},
			opts,
		);
		const newId = stored.ids[0] ?? makeIdempotentId(`${userId}|${botId}|${nowMs()}|${input.content}`);
		return { deprecatedId: input.id, newId };
	}

	async function retire(
		input: { id: string; reason?: string; scopeId?: string; userId?: string },
		opts?: BackendCallOptions,
	): Promise<{ ok: true }> {
		const { manager, ready } = await ensureInit();
		if (!ready) return { ok: true };
		const userId = resolveUser(input.userId);
		if (typeof manager.deprecateMessages !== "function") {
			// No-op when the storage adapter doesn't support soft deprecation.
			return { ok: true };
		}
		await withTimeout(
			manager.deprecateMessages([input.id], {
				reason: input.reason ?? "retired",
				deprecatedAt: nowMs(),
				userId,
			}),
			opts?.timeoutMs ?? config.timeoutMs,
			opts?.signal,
		);
		return { ok: true };
	}

	async function captureSource(input: CaptureInput, opts?: BackendCallOptions): Promise<{ id: string }> {
		const result = await remember(
			{
				content: input.content,
				sourceType: input.sourceType ?? "user_input",
				metadata: input.metadata,
				userId: input.userId,
				botId: input.botId,
			},
			opts,
		);
		const id = result.ids[0] ?? makeIdempotentId(`${input.userId ?? "dsh-default"}|capture|${randomUUID()}`);
		return { id };
	}

	async function uploadDocument(
		input: UploadDocumentInput,
		opts?: BackendCallOptions,
	): Promise<{ documentId: string; chunks: number }> {
		const store = getKnowledgeStore();
		return await withTimeout(
			store.uploadDocument({
				content: input.content,
				filename: input.filename,
				mimeType: input.mimeType,
				metadata: input.metadata,
				scopeId: input.scopeId || config.scopeId || "dsh-default",
				userId: input.userId || config.scopeId || "dsh-default",
			}),
			opts?.timeoutMs ?? config.timeoutMs,
			opts?.signal,
		);
	}

	async function searchKnowledge(
		input: SearchKnowledgeInput,
		opts?: BackendCallOptions,
	): Promise<{ chunks: import("./backend.js").KnowledgeChunkResult[] }> {
		const store = getKnowledgeStore();
		return await withTimeout(
			store.searchKnowledge({
				query: input.query,
				documentIds: input.documentIds,
				limit: input.limit,
				threshold: input.threshold,
				scopeId: input.scopeId || config.scopeId || "dsh-default",
				userId: input.userId || config.scopeId || "dsh-default",
			}),
			opts?.timeoutMs ?? config.timeoutMs,
			opts?.signal,
		);
	}

	async function listDocuments(
		input: ListDocumentsInput,
		opts?: BackendCallOptions,
	): Promise<{ documents: import("./backend.js").KnowledgeDocumentResult[] }> {
		const store = getKnowledgeStore();
		return await withTimeout(
			store.listDocuments({
				limit: input.limit,
				scopeId: input.scopeId || config.scopeId || "dsh-default",
				userId: input.userId || config.scopeId || "dsh-default",
			}),
			opts?.timeoutMs ?? config.timeoutMs,
			opts?.signal,
		);
	}

	async function searchInsights(
		input: SearchInsightsInput,
		opts?: BackendCallOptions,
	): Promise<{ insights: import("./backend.js").InsightResult[] }> {
		const userId = input.userId || config.scopeId || "dsh-default";
		const scopeId = input.scopeId || config.scopeId || "dsh-default";

		// Search returns a stripped metadata view, so first get candidate IDs
		// by query, then fetch full records via get() to inspect sourceType/category.
		const hits = await search(
			{
				query: input.query,
				limit: input.limit * 3,
				threshold: input.threshold,
				scopeId,
				userId,
			},
			opts,
		);

		if (hits.length === 0) {
			return { insights: [] };
		}

		const fullItems = await get({ ids: hits.map((h) => h.id), scopeId, userId }, opts);
		const itemById = new Map(fullItems.map((item) => [item.id, item]));

		const insights: import("./backend.js").InsightResult[] = [];
		for (const hit of hits) {
			const item = itemById.get(hit.id);
			if (!item) continue;
			if (item.metadata?.sourceType !== "insight") continue;
			if (
				input.categories &&
				input.categories.length > 0 &&
				!input.categories.includes(String(item.metadata?.category))
			) {
				continue;
			}
			insights.push({
				id: item.id,
				content: item.content,
				category: String(item.metadata?.category ?? "fact"),
				score: hit.score,
				timestamp: item.timestamp,
				metadata: item.metadata,
			});
		}

		return { insights: insights.slice(0, input.limit) };
	}

	async function captureInsight(
		input: CaptureInsightInput,
		opts?: BackendCallOptions,
	): Promise<{ id: string }> {
		const result = await remember(
			{
				content: input.content,
				sourceType: "insight",
				metadata: {
					category: input.category,
					...input.metadata,
				},
				scopeId: input.scopeId || config.scopeId || "dsh-default",
				userId: input.userId || config.scopeId || "dsh-default",
			},
			opts,
		);
		return { id: result.ids[0] ?? "" };
	}

	async function health(): Promise<{
		ok: boolean;
		mode: "lib";
		details?: string;
	}> {
		try {
			const { ready, search } = await ensureInit();
			if (!ready) {
				return {
					ok: false,
					mode: "lib",
					details: "raw message storage not initialised",
				};
			}
			const userId = resolveUser();
			if (search) {
				await withTimeout(
					search.search({
						userId,
						query: "__health__",
						limit: 1,
						threshold: -1,
					}),
					Math.min(config.timeoutMs, 2000),
					undefined,
				);
			}
			const dbPath = process.env.MEMORY_STORE_DB_PATH ?? getOpenContextPath("memory", "store.db");
			return { ok: true, mode: "lib", details: `db=${dbPath}` };
		} catch (error) {
			return {
				ok: false,
				mode: "lib",
				details: (error as Error).message ?? "unknown error",
			};
		}
	}

	async function dispose(): Promise<void> {
		try {
			knowledgeStore?.close();
		} catch {
			// ignore
		}
		try {
			const mod = await import("@melandlabs/opencontext");
			const close = (mod as unknown as { closeRawMessageStore?: () => Promise<void> }).closeRawMessageStore;
			if (typeof close === "function") await close();
		} catch {
			// ignore
		}
	}

	return {
		mode: "lib",
		search,
		remember,
		list,
		get,
		revise,
		retire,
		captureSource,
		uploadDocument,
		searchKnowledge,
		listDocuments,
		searchInsights,
		captureInsight,
		health,
		dispose,
	};
}
