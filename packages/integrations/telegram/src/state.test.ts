import { describe, it, expect } from "vitest";
import {
  calculateBackoffDelay,
  isConnectionStale,
  resolveConnectionState,
  shouldProcessMessage,
  pruneOwnSentIds,
} from "./state";

describe("calculateBackoffDelay", () => {
  const baseMs = 5000;
  const maxAttempts = 5;

  it("returns 5s for attempt 0", () => {
    const result = calculateBackoffDelay(0, baseMs, maxAttempts);
    expect(result.delayMs).toBe(5000);
    expect(result.shouldGiveUp).toBe(false);
  });

  it("returns 10s for attempt 1", () => {
    const result = calculateBackoffDelay(1, baseMs, maxAttempts);
    expect(result.delayMs).toBe(10000);
    expect(result.shouldGiveUp).toBe(false);
  });

  it("returns 20s for attempt 2", () => {
    const result = calculateBackoffDelay(2, baseMs, maxAttempts);
    expect(result.delayMs).toBe(20000);
    expect(result.shouldGiveUp).toBe(false);
  });

  it("returns 40s for attempt 3", () => {
    const result = calculateBackoffDelay(3, baseMs, maxAttempts);
    expect(result.delayMs).toBe(40000);
    expect(result.shouldGiveUp).toBe(false);
  });

  it("returns 80s for attempt 4", () => {
    const result = calculateBackoffDelay(4, baseMs, maxAttempts);
    expect(result.delayMs).toBe(80000);
    expect(result.shouldGiveUp).toBe(false);
  });

  it("gives up when attempts reach maxAttempts", () => {
    const result = calculateBackoffDelay(5, baseMs, maxAttempts);
    expect(result.shouldGiveUp).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it("gives up when attempts exceed maxAttempts", () => {
    const result = calculateBackoffDelay(10, baseMs, maxAttempts);
    expect(result.shouldGiveUp).toBe(true);
  });
});

describe("isConnectionStale", () => {
  const staleThresholdMs = 3 * 60_000; // 3 minutes

  it("returns false when elapsed is within threshold", () => {
    const now = 1_000_000;
    const lastEventTime = now - staleThresholdMs + 1;
    expect(isConnectionStale(lastEventTime, now, staleThresholdMs)).toBe(false);
  });

  it("returns true when elapsed exceeds threshold", () => {
    const now = 1_000_000;
    const lastEventTime = now - staleThresholdMs - 1;
    expect(isConnectionStale(lastEventTime, now, staleThresholdMs)).toBe(true);
  });

  it("returns true when elapsed equals threshold (strictly greater check)", () => {
    const now = 1_000_000;
    const lastEventTime = now - staleThresholdMs;
    expect(isConnectionStale(lastEventTime, now, staleThresholdMs)).toBe(false);
  });
});

describe("resolveConnectionState", () => {
  it("maps numeric codes correctly", () => {
    expect(resolveConnectionState(0)).toBe("connecting");
    expect(resolveConnectionState(1)).toBe("connected");
    expect(resolveConnectionState(2)).toBe("disconnected");
    expect(resolveConnectionState(-1)).toBe("connectionLost");
  });

  it("returns unknown wrapper for unrecognized codes", () => {
    expect(resolveConnectionState(99)).toBe("unknown(99)");
    expect(resolveConnectionState("foo")).toBe("unknown(foo)");
  });
});

describe("shouldProcessMessage", () => {
  it("processes new messages not in ownSentIds", () => {
    expect(shouldProcessMessage(10, 5, new Set([1, 2, 3]))).toBe(true);
  });

  it("skips messages with id <= lastProcessedId", () => {
    expect(shouldProcessMessage(5, 5, new Set())).toBe(false);
    expect(shouldProcessMessage(3, 5, new Set())).toBe(false);
  });

  it("skips messages in ownSentIds even if id > lastProcessedId", () => {
    expect(shouldProcessMessage(10, 5, new Set([10]))).toBe(false);
  });
});

describe("pruneOwnSentIds", () => {
  it("does nothing when size is within cap", () => {
    const set = new Set([1, 2, 3]);
    pruneOwnSentIds(set, 5);
    expect(set.size).toBe(3);
  });

  it("removes the oldest entry when cap is exceeded", () => {
    const set = new Set([1, 2, 3, 4, 5]);
    pruneOwnSentIds(set, 4);
    expect(set.size).toBe(4);
    expect(set.has(1)).toBe(false);
    expect(set.has(5)).toBe(true);
  });

  it("handles a single-item overflow", () => {
    const set = new Set([42]);
    pruneOwnSentIds(set, 0);
    expect(set.size).toBe(0);
  });
});
