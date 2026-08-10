/**
 * WhatsApp Message History Store
 *
 * File-backed replacement for the minimal in-memory Baileys store (Baileys v7
 * removed makeInMemoryStore). Full WAMessage objects stay in memory for
 * real-time consumers; a sanitized copy (binary payloads dropped, Long
 * timestamps normalized to numbers) is persisted per chat so message history
 * and the chat list survive process restarts. Persisted messages also provide
 * the anchor (oldest message key + timestamp) required by Baileys'
 * sock.fetchMessageHistory on-demand backfill API.
 *
 * Layout:
 *   <baseDir>/<accountId>/chats.json
 *   <baseDir>/<accountId>/messages/<base64url(jid)>.json
 *
 * ARCHITECTURE EXCEPTION (per repo rule: exceptions must be explicit).
 * Data is stored as plain JSON, unencrypted.
 * - Why: matches the Baileys auth state in local/Tauri mode, which already
 *   sits unencrypted in the same data dir and grants full account access.
 * - Impact scope: in cloud deployments the auth state lives in Redis, so this
 *   directory is an additional at-rest exposure of message content on the
 *   server filesystem.
 * - Temporary: yes — the follow-up is to encrypt at rest in cloud mode using
 *   packages/security (key management decision pending), or scope this store
 *   to local/Tauri mode only.
 * - Mitigation today: per-chat cap (500 msgs), binary payloads stripped, and
 *   mandatory lifecycle cleanup — callers must invoke
 *   WhatsAppMessageHistoryStore.purgeAccountData() when the integration
 *   account is disconnected so no message content outlives the account
 *   (purge also destroys live in-process instances; see tests in
 *   message-history-store.test.ts).
 * - Known gaps for the encryption follow-up: whole-user account deletion
 *   paths that bypass integration disconnect do not purge; in multi-instance
 *   cloud deployments purge only clears the current instance's filesystem.
 *
 * Limitation: sanitization strips media keys/thumbnails, so messages
 * hydrated from disk cannot be passed to downloadMediaMessage — only text
 * extraction and backfill anchoring work on persisted history.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { proto } from "@whiskeysockets/baileys";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";

/**
 * Per-chat storage cap. Readers (getChatsByChunk) must use the same value:
 * the backfill anchor is the oldest STORED message, so a smaller read window
 * would silently hide stored in-window messages and waste backfill budget.
 */
export const MAX_PERSISTED_MESSAGES_PER_CHAT = 500;
const MAX_MESSAGES_PER_JID = MAX_PERSISTED_MESSAGES_PER_CHAT;
const FLUSH_DEBOUNCE_MS = 2000;
// Per timer pass; bounds the synchronous write burst after a full history sync.
const FLUSH_MAX_FILES_PER_PASS = 50;
// Stop retrying flushes after this many consecutive failures (disk full,
// permission errors) instead of rescheduling and warning every 2s forever.
const MAX_CONSECUTIVE_FLUSH_FAILURES = 5;

export type PersistedChatInfo = {
  id: string;
  name?: string;
};

function defaultBaseDir(): string {
  return join(homedir(), ".openloomi", "data", "whatsapp-history");
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function jidToFilename(jid: string): string {
  return `${Buffer.from(jid, "utf8").toString("base64url")}.json`;
}

function filenameToJid(filename: string): string | null {
  if (!filename.endsWith(".json")) return null;
  try {
    return Buffer.from(filename.slice(0, -5), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function isLongLike(
  value: object,
): value is { low: number; high: number; unsigned: boolean } {
  const v = value as { low?: unknown; high?: unknown; unsigned?: unknown };
  return (
    typeof v.low === "number" &&
    typeof v.high === "number" &&
    typeof v.unsigned === "boolean"
  );
}

function longToNumber(value: {
  low: number;
  high: number;
  toNumber?: () => number;
}): number {
  if (typeof value.toNumber === "function") return value.toNumber();
  return value.high * 4294967296 + (value.low >>> 0);
}

/**
 * Make a WAMessage JSON-safe: drop binary payloads (media keys, thumbnails)
 * and convert protobuf Long values to plain numbers. Text content and message
 * keys — everything insights extraction and backfill anchors need — survive.
 */
export function sanitizeMessageForPersistence(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array) return undefined;
  if (isLongLike(value)) return longToNumber(value);
  if (Array.isArray(value)) {
    // Filter dropped (binary) elements out instead of leaving undefined,
    // which JSON.stringify would turn into null holes inside arrays.
    return value
      .map(sanitizeMessageForPersistence)
      .filter((entry) => entry !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeMessageForPersistence(entry);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

/**
 * Live instances per account dir — lets purge destroy in-process stores.
 * Holds STRONG references: any code path that creates a store and abandons
 * it without calling destroy() leaks the instance (and its message cache)
 * until the account is purged. Today every creation site either reuses a
 * single instance (adapter) or destroys the old one on adoption (listener).
 */
const liveStores = new Map<string, Set<WhatsAppMessageHistoryStore>>();

class WhatsAppMessageHistoryStore {
  private readonly accountDir: string;
  private readonly messagesDir: string;
  private messages: Map<string, WAMessage[]> = new Map();
  /** Per-chat id sets mirroring `messages`, for O(1) dedup on insert. */
  private messageIds: Map<string, Set<string>> = new Map();
  private hydratedJids = new Set<string>();
  private chats: Map<string, PersistedChatInfo> = new Map();
  private chatsHydrated = false;
  private dirtyJids = new Set<string>();
  private chatsDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFlushFailures = 0;
  private closed = false;
  private readonly persistEnabled: boolean;
  /** ON_DEMAND history responses seen — backfill's "phone answered" signal. */
  private onDemandResponses = 0;

  /**
   * Delete all persisted history for an account. Must be called when the
   * integration account is disconnected/removed so message content does not
   * outlive the account on disk. Live store instances for the account are
   * destroyed first — otherwise their pending debounced flushes (or messages
   * still arriving on an undisposed socket) would resurrect the files.
   */
  static purgeAccountData(accountId: string, baseDir?: string): void {
    const dir = join(
      baseDir ?? defaultBaseDir(),
      sanitizeForFilename(accountId),
    );
    for (const store of liveStores.get(dir) ?? []) {
      store.destroy();
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `[WhatsAppMessageHistoryStore] Failed to purge ${dir}:`,
        error,
      );
    }
  }

  constructor(opts: {
    accountId: string;
    baseDir?: string;
    persist?: boolean;
  }) {
    const base = opts.baseDir ?? defaultBaseDir();
    this.accountDir = join(base, sanitizeForFilename(opts.accountId));
    this.messagesDir = join(this.accountDir, "messages");
    // persist=false keeps the store memory-only: used when the account key
    // is a random per-instance id — files under such a key could never be
    // found again nor purged, leaving orphaned plain-text message dirs.
    this.persistEnabled = opts.persist ?? true;
    const registered = liveStores.get(this.accountDir) ?? new Set();
    registered.add(this);
    liveStores.set(this.accountDir, registered);
  }

  /**
   * Permanently disable this store: stop pending flushes, drop in-memory
   * data, and turn all writes into no-ops. Called by purgeAccountData so a
   * disconnected account's messages cannot be re-persisted.
   */
  /** True once destroy() has run — writes are no-ops; do not attach/reuse. */
  get isClosed(): boolean {
    return this.closed;
  }

  destroy(): void {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirtyJids.clear();
    this.chatsDirty = false;
    this.messages.clear();
    this.messageIds.clear();
    this.chats.clear();
    liveStores.get(this.accountDir)?.delete(this);
  }

  /**
   * Attach event listeners to a WASocket to populate the store. History
   * arrives via phone-pushed messaging-history.set (initial pairing and
   * ON_DEMAND backfill responses); real-time messages via messages.upsert.
   */
  attach(sock: WASocket): void {
    sock.ev.on("messages.upsert", ({ messages }) => {
      this.addMessages(messages);
    });
    sock.ev.on(
      "messaging-history.set",
      (data: {
        chats?: Array<{ id?: string | null; name?: string | null }>;
        messages?: WAMessage[];
        syncType?: number | null;
      }) => {
        // Counting lives here (not on the socket): the store is the one
        // component that gets re-attached whenever socket listeners are
        // stripped (see self-listener stop()), so the signal survives.
        if (data.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
          this.onDemandResponses++;
        }
        if (data.chats?.length) this.addChats(data.chats);
        if (data.messages?.length) this.addMessages(data.messages);
      },
    );
    sock.ev.on(
      "chats.upsert",
      (chats: Array<{ id?: string | null; name?: string | null }>) => {
        this.addChats(chats);
      },
    );
  }

  addMessages(msgs: WAMessage[]): void {
    if (this.closed) return;
    const touched = new Set<string>();
    for (const msg of msgs) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      this.hydrate(jid);
      const ids = this.messageIds.get(jid) ?? new Set();
      const msgId = msg.key.id ?? "";
      if (msgId && ids.has(msgId)) continue;
      const existing = this.messages.get(jid) ?? [];
      existing.push(msg);
      if (msgId) ids.add(msgId);
      this.messages.set(jid, existing);
      this.messageIds.set(jid, ids);
      touched.add(jid);
    }
    for (const jid of touched) {
      const list = this.messages.get(jid);
      if (!list) continue;
      list.sort(
        (a, b) =>
          Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0),
      );
      if (list.length > MAX_MESSAGES_PER_JID) {
        const trimmed = list.splice(0, list.length - MAX_MESSAGES_PER_JID);
        const ids = this.messageIds.get(jid);
        for (const msg of trimmed) {
          if (msg.key.id) ids?.delete(msg.key.id);
        }
      }
      this.dirtyJids.add(jid);
    }
    if (touched.size) this.scheduleFlush();
  }

  addChats(chats: Array<{ id?: string | null; name?: string | null }>): void {
    if (this.closed) return;
    this.hydrateChats();
    let changed = false;
    for (const chat of chats) {
      if (!chat.id || chat.id === "status@broadcast") continue;
      const name =
        chat.name ??
        (chat as { subject?: string | null }).subject ??
        this.chats.get(chat.id)?.name;
      const existing = this.chats.get(chat.id);
      if (existing && existing.name === (name ?? existing.name)) continue;
      this.chats.set(chat.id, { id: chat.id, name: name ?? undefined });
      changed = true;
    }
    if (changed) {
      this.chatsDirty = true;
      this.scheduleFlush();
    }
  }

  /** Same interface as the old in-memory store (used by Baileys consumers). */
  async loadMessages(
    jid: string,
    count: number,
    _opts: object,
  ): Promise<WAMessage[]> {
    this.hydrate(jid);
    const msgs = this.messages.get(jid) ?? [];
    return msgs.slice(-count);
  }

  /** Chronologically oldest stored message — the fetchMessageHistory anchor. */
  getOldestMessage(jid: string): WAMessage | undefined {
    this.hydrate(jid);
    return this.messages.get(jid)?.[0];
  }

  /**
   * Number of ON_DEMAND history sync responses received since this store
   * instance was created. Used by backfill to distinguish "phone answered
   * with nothing older" (end of history) from "phone never answered".
   */
  getOnDemandResponseCount(): number {
    return this.onDemandResponses;
  }

  /**
   * False once the per-chat cap is reached: addMessages trims the oldest
   * entries, so backfilled history would be discarded immediately and the
   * oldest anchor would never move — requesting more is pointless.
   */
  canStoreOlderMessages(jid: string): boolean {
    this.hydrate(jid);
    return (this.messages.get(jid)?.length ?? 0) < MAX_MESSAGES_PER_JID;
  }

  /** Persisted chat list, used to rebuild adapter state after a restart. */
  loadChats(): PersistedChatInfo[] {
    this.hydrateChats();
    return Array.from(this.chats.values());
  }

  /** Write all pending changes to disk immediately. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.persistEnabled) return;
    this.writePending(Number.POSITIVE_INFINITY);
  }

  /**
   * Write up to maxFiles dirty chats. The initial full history sync can dirty
   * hundreds of chats at once; writing them all synchronously in one tick
   * would stall the event loop right in the middle of onboarding, so the
   * debounced timer writes in batches and reschedules for the remainder.
   * Explicit flush() still drains everything (teardown must not lose data).
   */
  private writePending(maxFiles: number): void {
    try {
      if (this.chatsDirty || this.dirtyJids.size) {
        // Owner-only permissions: plain-text message content must not be
        // readable by other users on a shared host.
        mkdirSync(this.messagesDir, { recursive: true, mode: 0o700 });
      }
      if (this.chatsDirty) {
        this.writeFileAtomic(
          join(this.accountDir, "chats.json"),
          JSON.stringify(Array.from(this.chats.values())),
        );
        this.chatsDirty = false;
      }
      let written = 0;
      for (const jid of this.dirtyJids) {
        if (written >= maxFiles) break;
        const sanitized = (this.messages.get(jid) ?? []).map((m) =>
          sanitizeMessageForPersistence(m),
        );
        this.writeFileAtomic(
          join(this.messagesDir, jidToFilename(jid)),
          JSON.stringify(sanitized),
        );
        this.dirtyJids.delete(jid);
        written++;
      }
      this.consecutiveFlushFailures = 0;
    } catch (error) {
      this.consecutiveFlushFailures++;
      console.warn("[WhatsAppMessageHistoryStore] Failed to flush:", error);
      if (this.consecutiveFlushFailures >= MAX_CONSECUTIVE_FLUSH_FAILURES) {
        // Persistent disk problem (full disk, permissions) — stop retrying
        // every 2s forever. In-memory data stays available; persistence for
        // the pending set is abandoned.
        console.warn(
          `[WhatsAppMessageHistoryStore] Giving up on flushing ${this.dirtyJids.size} chat(s) after ${this.consecutiveFlushFailures} consecutive failures`,
        );
        this.dirtyJids.clear();
        this.chatsDirty = false;
        // Reset so a future batch gets the full failure tolerance again
        // (a single transient error must not instantly drop new data).
        this.consecutiveFlushFailures = 0;
        return;
      }
    }
    if (this.dirtyJids.size || this.chatsDirty) {
      this.scheduleFlush();
    }
  }

  /**
   * Write via temp file + rename so a crash can't leave truncated JSON.
   * The pid suffix keeps multi-worker processes from racing on the same
   * temp path (each still last-write-wins on the final file).
   */
  private writeFileAtomic(filePath: string, content: string): void {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  }

  private scheduleFlush(): void {
    if (this.closed || !this.persistEnabled) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writePending(FLUSH_MAX_FILES_PER_PASS);
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private hydrate(jid: string): void {
    if (!this.persistEnabled) return;
    if (this.hydratedJids.has(jid)) return;
    // Marked before the read on purpose: a failing file should not be
    // re-read (and re-logged) on every loadMessages call; the chat simply
    // starts from live data until it gets rewritten by the next flush.
    this.hydratedJids.add(jid);
    try {
      const file = join(this.messagesDir, jidToFilename(jid));
      if (!existsSync(file)) return;
      const persisted = JSON.parse(readFileSync(file, "utf8")) as WAMessage[];
      if (!Array.isArray(persisted) || persisted.length === 0) return;
      const existing = this.messages.get(jid) ?? [];
      const ids = this.messageIds.get(jid) ?? new Set<string>();
      for (const msg of existing) {
        if (msg.key.id) ids.add(msg.key.id);
      }
      for (const msg of persisted) {
        if (!msg?.key?.id || ids.has(msg.key.id)) continue;
        existing.push(msg);
        ids.add(msg.key.id);
      }
      existing.sort(
        (a, b) =>
          Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0),
      );
      if (existing.length > MAX_MESSAGES_PER_JID) {
        const trimmed = existing.splice(
          0,
          existing.length - MAX_MESSAGES_PER_JID,
        );
        for (const msg of trimmed) {
          if (msg.key.id) ids.delete(msg.key.id);
        }
      }
      this.messages.set(jid, existing);
      this.messageIds.set(jid, ids);
    } catch (error) {
      console.warn(
        `[WhatsAppMessageHistoryStore] Failed to hydrate ${jid}:`,
        error,
      );
    }
  }

  private hydrateChats(): void {
    if (!this.persistEnabled) return;
    if (this.chatsHydrated) return;
    this.chatsHydrated = true;
    try {
      const file = join(this.accountDir, "chats.json");
      if (existsSync(file)) {
        const persisted = JSON.parse(
          readFileSync(file, "utf8"),
        ) as PersistedChatInfo[];
        if (Array.isArray(persisted)) {
          for (const chat of persisted) {
            if (chat?.id && !this.chats.has(chat.id)) {
              this.chats.set(chat.id, chat);
            }
          }
          return;
        }
      }
      // Fallback: derive the chat list from persisted message files when
      // chats.json is missing (e.g. written by an older version).
      if (existsSync(this.messagesDir)) {
        for (const filename of readdirSync(this.messagesDir)) {
          const jid = filenameToJid(filename);
          if (jid && !this.chats.has(jid)) {
            this.chats.set(jid, { id: jid });
          }
        }
      }
    } catch (error) {
      console.warn(
        "[WhatsAppMessageHistoryStore] Failed to hydrate chats:",
        error,
      );
    }
  }
}

export { WhatsAppMessageHistoryStore };
