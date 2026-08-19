/**
 * VSA (Vector Symbolic Architecture) persistence types.
 *
 * Lives in `@melandlabs/contracts` because both `@melandlabs/sqlite` (the
 * `vsa_facts` table impl) and `@melandlabs/memory-store` (the SDK wrapper)
 * need to share the shape. Putting them in `@melandlabs/memory-store`
 * would create a circular `memory-store → sqlite → memory-store` edge
 * because `memory-store` already depends on `sqlite`.
 *
 * These types are pure data shapes — they carry no HRR algebra and no
 * SDK behaviour. See `@melandlabs/vsa` for the algebra (`bind`/`unbind`/
 * `superpose`/`cleanup`) and `@melandlabs/memory-store/src/search/vsa.ts`
 * for the SDK wrapper.
 */

// ─────────────────────────────────────────────────────────────────────────
// Persisted fact shape
// ─────────────────────────────────────────────────────────────────────────

/** A persisted (role, filler) binding with both vectors preserved. */
export interface VsaFact {
	factId: string;
	userId: string;
	roleLabel: string;
	fillerLabel: string;
	/** Float32 bytes of the role vector at store time. */
	roleVector: number[];
	/** Float32 bytes of the filler vector at store time. */
	fillerVector: number[];
	dim: number;
	/** Optional scope tag so a single user can have multiple VSA memories.
	 * Defaults to "default". */
	scopeTag: string;
	/** Optional botId for filtering when the store mixes multiple agents. */
	botId?: string;
	createdAt: number;
	deprecatedAt?: number;
	deprecationReason?: string;
}

/** Read-side projection of a VsaFact, with vectors stripped. */
export interface VsaFactSummary {
	factId: string;
	userId: string;
	roleLabel: string;
	fillerLabel: string;
	scopeTag: string;
	botId?: string;
	createdAt: number;
	deprecatedAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Verb input/output shapes
// ─────────────────────────────────────────────────────────────────────────

export interface StoreVsaFactInput {
	userId: string;
	roleLabel: string;
	fillerLabel: string;
	/** Role vector. The store will copy and persist these bytes. */
	roleVector: number[] | Float32Array;
	/** Filler vector. The store will copy and persist these bytes. */
	fillerVector: number[] | Float32Array;
	/** Optional dim override; defaults to `roleVector.length`. */
	dim?: number;
	/** Optional scope tag; defaults to "default". */
	scopeTag?: string;
	botId?: string;
	/** Optional explicit id; auto-generated as `vsa-<timestamp>-<rand>` if omitted. */
	factId?: string;
}

export interface StoreVsaFactOutput {
	factId: string;
	createdAt: number;
}

export interface VsaVocabularyEntry {
	label: string;
	vector: number[] | Float32Array;
}

export interface VsaRecallInput {
	userId: string;
	roleLabel: string;
	/** Role vector used at recall time. Must equal the role vector bound at
	 * store time on every fact in the active memory (the store compares
	 * element-wise and warns on mismatch). */
	roleVector: number[] | Float32Array;
	/** Vocabulary to cleanup against. The store returns the best-match label. */
	vocabulary: VsaVocabularyEntry[];
	/** Optional scope tag; defaults to "default". */
	scopeTag?: string;
	botId?: string;
	/** Cap on facts loaded into the memory vector. Defaults to 1000.
	 * HRR crosstalk grows as O(√D / factCount); the cap protects recall quality. */
	maxFacts?: number;
}

export interface VsaRecallScore {
	label: string;
	score: number;
}

export interface VsaRecallOutput {
	fillerLabel: string;
	score: number;
	/** Cosine similarity of the cleaned candidate against every vocabulary
	 * entry, sorted descending. The top entry is `fillerLabel`. */
	allScores: VsaRecallScore[];
	/** Number of facts that contributed to the memory vector. Zero facts
	 * returns an empty result plus a `vsa_no_facts` warning. */
	factCount: number;
	warnings: Array<{ code: string; message: string }>;
}

export interface VsaListInput {
	userId: string;
	scopeTag?: string;
	botId?: string;
	/** When false (default), deprecated facts are filtered out. */
	includeDeprecated?: boolean;
}

export interface VsaForgetInput {
	userId: string;
	factIds: string[];
	/** Short tag like "superseded_by:<new-fact-id>" or "user_requested". */
	reason?: string;
}

export interface VsaForgetOutput {
	deprecatedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Storage contract
// ─────────────────────────────────────────────────────────────────────────

/** Storage contract for VSA facts. Hosts may swap in a custom backend
 * (IndexedDB, Postgres, …) by implementing this interface. */
export interface VsaFactStorage {
	/** Persist a single fact. Idempotent on `factId` — re-storing with the
	 * same id overwrites the previous row. */
	storeFact(fact: VsaFact): Promise<void>;
	/** Read facts for a user, optionally narrowed by scope/botId. Excludes
	 * deprecated rows unless `includeDeprecated` is true. */
	queryFacts(input: {
		userId: string;
		scopeTag?: string;
		botId?: string;
		includeDeprecated?: boolean;
		limit?: number;
	}): Promise<VsaFact[]>;
	/** Soft-delete facts by id. Idempotent — already-deprecated rows return 0. */
	deprecateFacts(input: {
		userId: string;
		factIds: string[];
		reason?: string;
		now?: number;
	}): Promise<{ deprecatedCount: number }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers (pure functions, no state)
// ─────────────────────────────────────────────────────────────────────────

/** Validate a vector argument and return its plain `number[]` copy. */
export function vsaNormalizeVector(value: number[] | Float32Array | undefined, field: string): number[] {
	if (value === undefined || value === null) {
		throw new Error(`VSA: ${field} is required`);
	}
	const arr: number[] = new Array(value.length);
	for (let i = 0; i < value.length; i += 1) {
		const n = value[i];
		if (!Number.isFinite(n)) {
			throw new Error(`VSA: ${field}[${i}] is not finite (${n})`);
		}
		arr[i] = n;
	}
	return arr;
}

/** Assert two vectors have the same length. */
export function vsaAssertSameDim(a: number[], b: number[], op: string): void {
	if (a.length !== b.length) {
		throw new Error(`${op}: dim mismatch (${a.length} vs ${b.length})`);
	}
}
