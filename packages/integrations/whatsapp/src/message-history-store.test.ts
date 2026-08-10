/**
 * WhatsApp Message History Store Tests
 *
 * File-backed store behavior: persistence across instances, chat list
 * recovery, oldest-message anchors for on-demand backfill, and sanitization
 * of protobuf artifacts (Long timestamps, binary payloads).
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WhatsAppMessageHistoryStore,
  sanitizeMessageForPersistence,
} from "./message-history-store";

const aliceJid = "2000@s.whatsapp.net";

function makeMessage(id: string, timestamp: number, text: string): WAMessage {
  return {
    key: { id, remoteJid: aliceJid, fromMe: false },
    message: { conversation: text },
    messageTimestamp: timestamp,
  } as WAMessage;
}

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "wa-history-store-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("WhatsAppMessageHistoryStore", () => {
  it("should persist messages and reload them in a new instance", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-1",
      baseDir,
    });
    store.addMessages([
      makeMessage("m1", 1700000000, "hello"),
      makeMessage("m2", 1700000100, "world"),
    ]);
    store.flush();

    const reloaded = new WhatsAppMessageHistoryStore({
      accountId: "acc-1",
      baseDir,
    });
    const messages = await reloaded.loadMessages(aliceJid, 10, {});
    expect(messages.map((m) => m.key.id)).toEqual(["m1", "m2"]);
    expect(messages[0].message?.conversation).toBe("hello");
  });

  it("should persist the chat list and restore it after a restart", () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-2",
      baseDir,
    });
    store.addChats([
      { id: aliceJid, name: "Alice" },
      { id: "3000-456@g.us", name: "Team" },
      { id: "status@broadcast", name: "Status" },
    ]);
    store.flush();

    const reloaded = new WhatsAppMessageHistoryStore({
      accountId: "acc-2",
      baseDir,
    });
    const chats = reloaded.loadChats();
    expect(chats).toHaveLength(2);
    expect(chats.map((c) => c.id).sort()).toEqual([aliceJid, "3000-456@g.us"]);
  });

  it("should keep messages sorted and return the chronologically oldest as anchor", () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-3",
      baseDir,
    });
    // History sync chunks can arrive out of order (RECENT before FULL).
    store.addMessages([makeMessage("newer", 1700000500, "later")]);
    store.addMessages([makeMessage("older", 1700000001, "earlier")]);

    expect(store.getOldestMessage(aliceJid)?.key.id).toBe("older");
  });

  it("should deduplicate messages by id across upsert and history events", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-4",
      baseDir,
    });
    const msg = makeMessage("dup", 1700000000, "once");
    store.addMessages([msg]);
    store.addMessages([msg]);

    const messages = await store.loadMessages(aliceJid, 10, {});
    expect(messages).toHaveLength(1);
  });

  it("should cap stored messages per chat at 500 keeping the newest", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-5",
      baseDir,
    });
    const batch = Array.from({ length: 510 }, (_, i) =>
      makeMessage(`m${i}`, 1700000000 + i, `msg ${i}`),
    );
    store.addMessages(batch);

    const messages = await store.loadMessages(aliceJid, 600, {});
    expect(messages).toHaveLength(500);
    expect(messages[0].key.id).toBe("m10");
    expect(messages[messages.length - 1].key.id).toBe("m509");
    // At capacity, older messages would be trimmed away — backfill callers
    // must be told not to request more history for this chat.
    expect(store.canStoreOlderMessages(aliceJid)).toBe(false);
  });

  it("should write debounced flushes in batches without losing chats", async () => {
    vi.useFakeTimers();
    try {
      const store = new WhatsAppMessageHistoryStore({
        accountId: "acc-batch",
        baseDir,
      });
      // Dirty more chats than one timer pass writes (50 per pass).
      for (let i = 0; i < 60; i++) {
        store.addMessages([
          {
            key: { id: `m-${i}`, remoteJid: `${i}@s.whatsapp.net` },
            message: { conversation: `msg ${i}` },
            messageTimestamp: 1700000000 + i,
          } as unknown as WAMessage,
        ]);
      }

      const messagesDir = join(baseDir, "acc-batch", "messages");
      // First debounced pass writes one batch and reschedules the rest.
      await vi.advanceTimersByTimeAsync(2000);
      expect(readdirSync(messagesDir).length).toBe(50);
      // The rescheduled pass drains the remainder.
      await vi.advanceTimersByTimeAsync(2000);
      expect(readdirSync(messagesDir).length).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should count ON_DEMAND history responses received through attach", () => {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    const sock = {
      ev: {
        on(event: string, fn: (data: unknown) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
        emit(event: string, data: unknown) {
          for (const fn of handlers.get(event) ?? []) fn(data);
        },
      },
    };
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-ondemand",
      baseDir,
    });
    store.attach(sock as never);

    expect(store.getOnDemandResponseCount()).toBe(0);
    // Initial sync chunks (no ON_DEMAND syncType) must not count.
    sock.ev.emit("messaging-history.set", { chats: [], messages: [] });
    expect(store.getOnDemandResponseCount()).toBe(0);
    sock.ev.emit("messaging-history.set", {
      chats: [],
      messages: [],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    });
    expect(store.getOnDemandResponseCount()).toBe(1);
  });

  it("should purge all persisted data for an account", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-purge",
      baseDir,
    });
    store.addMessages([makeMessage("m1", 1700000000, "to be purged")]);
    store.addChats([{ id: aliceJid, name: "Alice" }]);
    store.flush();
    expect(existsSync(join(baseDir, "acc-purge"))).toBe(true);

    WhatsAppMessageHistoryStore.purgeAccountData("acc-purge", baseDir);

    expect(existsSync(join(baseDir, "acc-purge"))).toBe(false);
    // A fresh store for the purged account must come up empty.
    const reloaded = new WhatsAppMessageHistoryStore({
      accountId: "acc-purge",
      baseDir,
    });
    expect(await reloaded.loadMessages(aliceJid, 10, {})).toEqual([]);
    expect(reloaded.loadChats()).toEqual([]);
  });

  it("should prevent live stores from resurrecting purged data", async () => {
    vi.useFakeTimers();
    try {
      const store = new WhatsAppMessageHistoryStore({
        accountId: "acc-live-purge",
        baseDir,
      });
      // Dirty data is pending (debounce not elapsed) when the purge happens.
      store.addMessages([
        makeMessage("pending", 1700000000, "not yet flushed"),
      ]);

      WhatsAppMessageHistoryStore.purgeAccountData("acc-live-purge", baseDir);

      // The pending debounced flush must not run and re-create the files...
      await vi.advanceTimersByTimeAsync(5000);
      expect(existsSync(join(baseDir, "acc-live-purge"))).toBe(false);

      // ...and messages still arriving on an undisposed socket are dropped.
      store.addMessages([makeMessage("late", 1700000100, "after purge")]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(existsSync(join(baseDir, "acc-live-purge"))).toBe(false);
      expect(await store.loadMessages(aliceJid, 10, {})).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should stop retrying flushes after repeated write failures", async () => {
    vi.useFakeTimers();
    try {
      // Point the account dir inside a FILE so mkdirSync always fails.
      const blocker = join(baseDir, "not-a-dir");
      writeFileSync(blocker, "block", "utf8");
      const store = new WhatsAppMessageHistoryStore({
        accountId: "x",
        baseDir: blocker,
      });
      store.addMessages([makeMessage("m1", 1700000000, "doomed")]);

      // Each debounced pass fails; after the failure cap the dirty set is
      // dropped and no further retry timer is scheduled.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }
      const internals = store as never as {
        dirtyJids: Set<string>;
        flushTimer: unknown;
      };
      expect(internals.dirtyJids.size).toBe(0);
      expect(internals.flushTimer).toBeNull();
      // In-memory reads keep working.
      expect(await store.loadMessages(aliceJid, 10, {})).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should stay memory-only when persistence is disabled", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-ephemeral",
      baseDir,
      persist: false,
    });
    store.addMessages([makeMessage("m1", 1700000000, "in memory only")]);
    store.addChats([{ id: aliceJid, name: "Alice" }]);
    store.flush();

    // Nothing may touch the disk — an unfindable random-key dir would be an
    // orphaned plain-text leak that purge can never reach.
    expect(existsSync(join(baseDir, "acc-ephemeral"))).toBe(false);
    // In-memory reads keep working for the lifetime of the socket.
    expect(await store.loadMessages(aliceJid, 10, {})).toHaveLength(1);
  });

  it("should persist files with owner-only permissions", () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-perms",
      baseDir,
    });
    store.addMessages([makeMessage("m1", 1700000000, "private")]);
    store.flush();

    const dirMode = statSync(join(baseDir, "acc-perms", "messages")).mode;
    expect(dirMode & 0o077).toBe(0);
    const [file] = readdirSync(join(baseDir, "acc-perms", "messages"));
    const fileMode = statSync(
      join(baseDir, "acc-perms", "messages", file),
    ).mode;
    expect(fileMode & 0o077).toBe(0);
  });

  it("should report capacity available for chats below the cap", () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-8",
      baseDir,
    });
    store.addMessages([makeMessage("only", 1700000000, "one message")]);
    expect(store.canStoreOlderMessages(aliceJid)).toBe(true);
  });

  it("should survive persistence of Long timestamps and binary payloads", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-6",
      baseDir,
    });
    const longLike = { low: 1700000000, high: 0, unsigned: false };
    store.addMessages([
      {
        key: { id: "media-1", remoteJid: aliceJid, fromMe: false },
        message: {
          imageMessage: {
            caption: "photo caption",
            jpegThumbnail: new Uint8Array([1, 2, 3]),
          },
        },
        messageTimestamp: longLike,
      } as unknown as WAMessage,
    ]);
    store.flush();

    const reloaded = new WhatsAppMessageHistoryStore({
      accountId: "acc-6",
      baseDir,
    });
    const [msg] = await reloaded.loadMessages(aliceJid, 10, {});
    expect(Number(msg.messageTimestamp)).toBe(1700000000);
    expect(msg.message?.imageMessage?.caption).toBe("photo caption");
    expect(msg.message?.imageMessage?.jpegThumbnail).toBeUndefined();
  });

  it("should merge persisted history with messages already in memory", async () => {
    const store = new WhatsAppMessageHistoryStore({
      accountId: "acc-7",
      baseDir,
    });
    store.addMessages([makeMessage("old", 1700000000, "from disk")]);
    store.flush();

    const reloaded = new WhatsAppMessageHistoryStore({
      accountId: "acc-7",
      baseDir,
    });
    // Real-time message arrives before the first disk read for this chat.
    reloaded.addMessages([makeMessage("live", 1700000200, "real-time")]);

    const messages = await reloaded.loadMessages(aliceJid, 10, {});
    expect(messages.map((m) => m.key.id)).toEqual(["old", "live"]);
  });
});

describe("sanitizeMessageForPersistence", () => {
  it("should convert nested Long-like values to numbers and drop Uint8Array", () => {
    const result = sanitizeMessageForPersistence({
      ts: { low: 42, high: 0, unsigned: true },
      blob: new Uint8Array([9]),
      nested: { text: "keep me" },
    }) as Record<string, unknown>;
    expect(result.ts).toBe(42);
    expect(result.blob).toBeUndefined();
    expect((result.nested as Record<string, unknown>).text).toBe("keep me");
  });

  it("should drop binary array elements instead of leaving null holes", () => {
    const result = sanitizeMessageForPersistence({
      list: [1, new Uint8Array([9]), "x"],
    }) as Record<string, unknown>;
    // After JSON round-trip there must be no null holes inside arrays.
    expect(JSON.parse(JSON.stringify(result)).list).toEqual([1, "x"]);
  });
});
