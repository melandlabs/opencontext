/**
 * @openloomi/memory-store — SDK entry point.
 *
 * Wires up a top-level `MemoryStore` facade combining the raw message
 * manager, the unified search facade, and vector index helpers. Hosts
 * that want a non-web backend (CLI daemon, custom server) can use
 * this as the only entry point.
 */

import type { MemoryStoreConfig } from "./config";
import {
  configureRawMessageStore,
  createRawMessageStore,
  getRawMessageManager,
  type RawMessageStore,
} from "./storage/raw-message-store";
import { createUnifiedSearch, type UnifiedSearch } from "./search/unified-search";

export interface MemoryStore {
  /** Underlying raw-message store (sqlite vs postgres). */
  raw: RawMessageStore;
  /** Unified semantic search facade (memory + insights + knowledge). */
  search: UnifiedSearch;
  /** Resolve the active raw-message manager. */
  getRawMessageManager: typeof getRawMessageManager;
  /** Run `searchUnifiedMemory` against the wired-up unified search. */
  searchUnifiedMemory: UnifiedSearch["searchUnifiedMemory"];
  /** Convenience: semantic search over raw messages only. */
  searchRawMemorySemantically: UnifiedSearch["searchRawMemorySemantically"];
}

export async function createMemoryStore(
  config: MemoryStoreConfig = {},
): Promise<MemoryStore> {
  const raw = createRawMessageStore({ env: config.env });
  const search = createUnifiedSearch(config.unified);

  // Make the legacy `getRawMessageManager()` module-level facade
  // point at this configuration so callers that don't go through
  // `createMemoryStore` still get the right backend.
  configureRawMessageStore(config);

  return {
    raw,
    search,
    getRawMessageManager,
    searchUnifiedMemory: search.searchUnifiedMemory,
    searchRawMemorySemantically: search.searchRawMemorySemantically,
  };
}

export type { MemoryStoreConfig };
export {
  createRawMessageStore,
  getRawMessageManager,
  isRawMessageStorageAvailable,
  getRawMessageStorageBackend,
  closeRawMessageStore,
  type RawMessageStorageBackend,
  type RawMessageStorageManagerWithSearch,
} from "./storage/raw-message-store";
export {
  registerPostgresFactory,
  clearPostgresFactory,
  hasPostgresFactory,
  resolvePostgresFactory,
  type PostgresFactoryFn,
  type PostgresRawMessageManagerLike,
} from "./storage/postgres-raw-message-factory";
export {
  createUnifiedSearch,
  type UnifiedSearch,
} from "./search/unified-search";
export type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
  UnifiedMemorySearchResult,
  UnifiedMemorySearchSource,
  UnifiedMemorySearchWarning,
} from "./search/utilities";
export {
  clampUnifiedMemorySearchLimit,
  clampUnifiedMemorySearchThreshold,
  isRawMemorySemanticResult,
  mergeUnifiedMemorySearchResults,
  normalizeUnifiedMemorySearchSources,
  toKnowledgeResult,
  toMemoryResult,
} from "./search/utilities";
export type { MemoryStoreDb, MemoryStoreEnv, VectorBackend, EmbedQueryFn, UnifiedSearchKnowledgeResult, UnifiedSearchInsightsResult } from "./config";
export type { RawMessage } from "./config";
