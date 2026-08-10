/**
 * Feishu WebSocket Listener — Pure State Layer
 *
 * Extracted from ws-listener.ts to enable memory-only unit testing
 * of deduplication, pruning, and routing logic without external IO.
 */

export interface FeishuRuntimeState {
  connections: Map<string, unknown>;
  processedMessageIds: Map<string, number>;
}

/** Create a fresh runtime state instance (replaces module-level globals for testability). */
export function createFeishuState(): FeishuRuntimeState {
  return {
    connections: new Map(),
    processedMessageIds: new Map(),
  };
}

/** Reset all mutable containers in a state instance. */
export function resetFeishuState(state: FeishuRuntimeState): void {
  state.connections.clear();
  state.processedMessageIds.clear();
}

/** Check whether a deduplication key has been seen within the TTL window. */
export function isDuplicate(
  dedupKey: string,
  cache: Map<string, number>,
  now: number,
  ttlMs: number,
): boolean {
  const ts = cache.get(dedupKey);
  if (ts === undefined) return false;
  return now - ts <= ttlMs;
}

/** Prune dedup cache: evict expired entries first, then trim by age if still over maxSize. */
export function pruneDedupCache(
  cache: Map<string, number>,
  now: number,
  maxSize: number,
  ttlMs: number,
): void {
  if (cache.size <= maxSize) return;

  // Phase 1: remove TTL-expired entries
  for (const [key, ts] of cache.entries()) {
    if (now - ts > ttlMs) cache.delete(key);
  }

  // Phase 2: if still over maxSize, remove oldest 50% by timestamp
  if (cache.size > maxSize) {
    const entries = [...cache.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries
      .slice(0, Math.floor(entries.length / 2))
      .map((e) => e[0]);
    toRemove.forEach((k) => cache.delete(k));
  }
}

/** Normalise Feishu chat_type to the internal p2p/group union. */
export function resolveChatType(raw: string): "p2p" | "group" {
  if (raw === "group" || raw === "topic_group") return "group";
  return "p2p";
}
