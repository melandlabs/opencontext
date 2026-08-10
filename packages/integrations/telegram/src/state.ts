/**
 * Telegram User Listener — Pure State Layer
 *
 * Extracted from TelegramUserListener to enable memory-only unit testing
 * of state-machine transitions without external IO (MTProto client, timers).
 */

/** Calculate exponential backoff delay and whether to give up. */
export function calculateBackoffDelay(
  attempts: number,
  baseMs: number,
  maxAttempts: number,
): { delayMs: number; shouldGiveUp: boolean } {
  const shouldGiveUp = attempts >= maxAttempts;
  if (shouldGiveUp) {
    return { delayMs: 0, shouldGiveUp: true };
  }
  const delayMs = baseMs * 2 ** attempts;
  return { delayMs, shouldGiveUp: false };
}

/** Determine whether a connection is stale based on last event time. */
export function isConnectionStale(
  lastEventTime: number,
  now: number,
  staleThresholdMs: number,
): boolean {
  const elapsed = now - lastEventTime;
  return elapsed > staleThresholdMs;
}

/** Map UpdateConnectionState numeric codes to human-readable strings. */
export function resolveConnectionState(stateCode: number | string): string {
  const stateMap: Record<number, string> = {
    0: "connecting",
    1: "connected",
    2: "disconnected",
    "-1": "connectionLost",
  };
  return stateMap[stateCode as number] || `unknown(${stateCode})`;
}

/** Decide whether an incoming message should be processed (idempotent + dedup). */
export function shouldProcessMessage(
  msgId: number,
  lastProcessedId: number,
  ownSentIds: Set<number>,
): boolean {
  if (msgId <= lastProcessedId) return false;
  if (ownSentIds.has(msgId)) return false;
  return true;
}

/** Evict oldest entries from own-sent message ID set when cap is exceeded. */
export function pruneOwnSentIds(set: Set<number>, maxSize: number): void {
  if (set.size <= maxSize) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) {
    set.delete(oldest);
  }
}
