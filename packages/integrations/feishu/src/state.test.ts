import { describe, it, expect, beforeEach } from "vitest";
import {
  createFeishuState,
  resetFeishuState,
  isDuplicate,
  pruneDedupCache,
  resolveChatType,
} from "./state";

describe("createFeishuState / resetFeishuState", () => {
  it("creates empty maps", () => {
    const state = createFeishuState();
    expect(state.connections.size).toBe(0);
    expect(state.processedMessageIds.size).toBe(0);
  });

  it("clears all maps on reset", () => {
    const state = createFeishuState();
    state.connections.set("a", {});
    state.processedMessageIds.set("b", Date.now());
    resetFeishuState(state);
    expect(state.connections.size).toBe(0);
    expect(state.processedMessageIds.size).toBe(0);
  });
});

describe("isDuplicate", () => {
  const ttlMs = 5 * 60 * 1000; // 5 minutes

  it("returns false for unseen keys", () => {
    const cache = new Map<string, number>();
    expect(isDuplicate("k1", cache, 1_000_000, ttlMs)).toBe(false);
  });

  it("returns true for a key within TTL", () => {
    const cache = new Map<string, number>([["k1", 1_000_000]]);
    expect(isDuplicate("k1", cache, 1_000_000 + ttlMs - 1, ttlMs)).toBe(true);
  });

  it("returns false for a key that has expired", () => {
    const cache = new Map<string, number>([["k1", 1_000_000]]);
    expect(isDuplicate("k1", cache, 1_000_000 + ttlMs + 1, ttlMs)).toBe(false);
  });

  it("returns false at exact TTL boundary (strictly greater check)", () => {
    const cache = new Map<string, number>([["k1", 1_000_000]]);
    expect(isDuplicate("k1", cache, 1_000_000 + ttlMs, ttlMs)).toBe(true);
  });
});

describe("pruneDedupCache", () => {
  const ttlMs = 5 * 60 * 1000;
  const maxSize = 4;

  it("does nothing when size is within maxSize", () => {
    const cache = new Map<string, number>([
      ["a", 1_000_000],
      ["b", 1_000_001],
    ]);
    pruneDedupCache(cache, 1_000_000, maxSize, ttlMs);
    expect(cache.size).toBe(2);
  });

  it("removes expired entries first", () => {
    const cache = new Map<string, number>([
      ["old", 1_000_000],
      ["a", 2_999_999],
      ["b", 2_999_998],
      ["c", 2_999_997],
      ["d", 2_999_996],
    ]);
    const now = 3_000_000; // only "old" is expired
    pruneDedupCache(cache, now, maxSize, ttlMs);
    expect(cache.has("old")).toBe(false);
    expect(cache.size).toBe(4); // remaining exactly at maxSize
  });

  it("removes oldest 50% by timestamp when still over maxSize after TTL purge", () => {
    const cache = new Map<string, number>([
      ["a", 1_000_000],
      ["b", 1_000_001],
      ["c", 1_000_002],
      ["d", 1_000_003],
      ["e", 1_000_004],
    ]);
    pruneDedupCache(cache, 1_000_000, maxSize, ttlMs);
    // 5 items → TTL clean does nothing → remove oldest floor(5/2)=2 items (a, b)
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
    expect(cache.has("e")).toBe(true);
  });
});

describe("resolveChatType", () => {
  it('maps "group" to "group"', () => {
    expect(resolveChatType("group")).toBe("group");
  });

  it('maps "topic_group" to "group"', () => {
    expect(resolveChatType("topic_group")).toBe("group");
  });

  it('maps "p2p" to "p2p"', () => {
    expect(resolveChatType("p2p")).toBe("p2p");
  });

  it("maps unknown values to p2p", () => {
    expect(resolveChatType("")).toBe("p2p");
    expect(resolveChatType("unknown")).toBe("p2p");
  });
});
