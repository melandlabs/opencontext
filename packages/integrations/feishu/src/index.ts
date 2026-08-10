/**
 * Feishu (Lark) platform adapter
 * Send messages via Feishu Open Platform API using app_id / app_secret
 * Needs to work with Feishu WebSocket long-poll listener to receive messages
 */
import { MessagePlatformAdapter } from "@openloomi/integrations/channels";
import type {
  Messages,
  Message,
  Image,
} from "@openloomi/integrations/channels";
import type {
  MessageEvent,
  MessageTarget,
} from "@openloomi/integrations/channels";
import type {
  Friend,
  Group,
  GroupMember,
} from "@openloomi/integrations/channels";
import { Permission } from "@openloomi/integrations/channels";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ExtractedMessageInfo } from "@openloomi/integrations/channels/sources/types";

const DEBUG = process.env.DEBUG_FEISHU === "true";

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
  /** International Lark tenant (consistent with device code registration domain) */
  domain?: "feishu" | "lark";
};

function isPlainText(m: Message): m is string {
  return typeof m === "string";
}

function isImageMessage(message: Message): message is Image {
  return (
    typeof message === "object" &&
    message !== null &&
    "url" in message &&
    typeof (message as Image).url === "string" &&
    (message as Image).url.length > 0
  );
}

function httpStatusError(
  message: string,
  status: number,
): Error & {
  status: number;
} {
  return Object.assign(new Error(message), { status });
}

/**
 * Detect receive_id_type based on Feishu ID prefixes.
 * Feishu IDs starting with "ou_" are open_id (user),
 * "on_" are union_id, "oc_" are chat_id (group/private chat).
 * Defaults to chat_id for unknown prefixes.
 */
function detectReceiveIdType(id: string): string {
  if (id.startsWith("ou_")) return "open_id";
  if (id.startsWith("on_")) return "union_id";
  if (id.startsWith("oc_")) return "chat_id";
  return "chat_id";
}

type FeishuMessagePayload = {
  msg_type: "text" | "post";
  content: string;
};

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|(\*\*|__|~~|`|\[[^\]]+\]\([^)]+\))/.test(
    text,
  );
}

function buildFeishuPayloads(text: string): FeishuMessagePayload[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const payloads: FeishuMessagePayload[] = [];
  if (looksLikeMarkdown(normalized)) {
    // Prefer Feishu rich post with markdown tag; fallback to plain text if tenant capability differs.
    payloads.push({
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "",
          content: [[{ tag: "md", text: normalized }]],
        },
      }),
    });
  }

  payloads.push({
    msg_type: "text",
    content: JSON.stringify({ text: normalized }),
  });

  return payloads;
}

function assertFeishuMessageCreateSucceeded(
  response: unknown,
  operation: string,
  msgType: string,
): void {
  if (!response || typeof response !== "object") return;
  const result = response as {
    code?: number;
    msg?: string;
    message?: string;
  };
  if (typeof result.code !== "number" || result.code === 0) return;

  const detail = result.msg ?? result.message ?? "unknown error";
  throw Object.assign(
    new Error(
      `[FeishuAdapter] ${operation} failed msg_type=${msgType} code=${result.code}: ${detail}`,
    ),
    { code: String(result.code) },
  );
}

/**
 * Extract plain text from Feishu content field (content is JSON string)
 */
function collectReadableStrings(
  value: unknown,
  out: string[],
  keyHint?: string,
): void {
  if (value == null) return;
  if (typeof value === "string") {
    const k = (keyHint ?? "").toLowerCase();
    if (
      /(^|_)(id|open_id|user_id|union_id|chat_id|message_id|image_key|file_key)$/.test(
        k,
      )
    ) {
      return;
    }
    const s = value.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReadableStrings(item, out, keyHint);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectReadableStrings(v, out, k);
    }
  }
}

function collectQuoteIds(
  value: unknown,
  out: Set<string>,
  keyHint?: string,
): void {
  if (value == null) return;
  if (typeof value === "string") {
    const k = (keyHint ?? "").toLowerCase();
    if (
      /(quote|reply|root|parent)/.test(k) &&
      /(id|message_id)$/.test(k) &&
      value.trim()
    ) {
      out.add(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectQuoteIds(item, out, keyHint);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectQuoteIds(v, out, k);
    }
  }
}

function collectImageKeys(
  value: unknown,
  out: Set<string>,
  keyHint?: string,
  inQuotedContext = false,
): void {
  if (value == null) return;
  if (typeof value === "string") {
    const k = (keyHint ?? "").toLowerCase();
    if (!inQuotedContext && /(^|_)image_key$/.test(k) && value.trim()) {
      out.add(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageKeys(item, out, keyHint, inQuotedContext);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const isQuotedField = /(quote|quoted|reply|root|parent|reference)/i.test(
        k,
      );
      collectImageKeys(v, out, k, inQuotedContext || isQuotedField);
    }
  }
}

function extractContentInfo(content: string | undefined | null): {
  text: string;
  quoteIds: string[];
  imageKeys: string[];
} {
  const raw = content ?? "";
  if (!raw.trim()) return { text: "", quoteIds: [], imageKeys: [] };
  try {
    const obj = JSON.parse(raw) as unknown;
    const chunks: string[] = [];
    const quoteIdSet = new Set<string>();
    const imageKeySet = new Set<string>();
    collectReadableStrings(obj, chunks);
    collectQuoteIds(obj, quoteIdSet);
    collectImageKeys(obj, imageKeySet);
    const normalized = Array.from(new Set(chunks)).join("\n").trim();
    const quoteIds = [...quoteIdSet];
    const imageKeys = [...imageKeySet];
    const quotePrefix =
      quoteIds.length > 0 ? `[Quote ID]: ${quoteIds.join(", ")}\n` : "";
    return {
      text: `${quotePrefix}${normalized}`.trim().slice(0, 10_000),
      quoteIds,
      imageKeys,
    };
  } catch {
    return { text: raw.trim(), quoteIds: [], imageKeys: [] };
  }
}

function extractImageKeysFromRawContent(raw: string): string[] {
  if (!raw?.trim()) return [];
  const out = new Set<string>();
  const imageKeyRegex = /"image_key"\s*:\s*"([^"]+)"/g;
  const fileKeyRegex = /"file_key"\s*:\s*"([^"]+)"/g;
  for (const regex of [imageKeyRegex, fileKeyRegex]) {
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = regex.exec(raw)) != null) {
      const k = m[1]?.trim();
      if (k) out.add(k);
    }
  }
  return [...out];
}

export class FeishuAdapter extends MessagePlatformAdapter {
  name = "Lark/Feishu";
  private client: Lark.Client | null = null;
  private credentials: FeishuCredentials;
  private botId: string;
  /** Open API base path (including /open-apis), used for token refresh and direct GET */
  private readonly openApisBase: string;
  private tenantTokenCache: { token: string; expiresAtMs: number } | null =
    null;
  private botOpenIdMemo: string | null | undefined;

  constructor(opts: {
    botId: string;
    appId: string;
    appSecret: string;
    domain?: "feishu" | "lark";
  }) {
    super();
    this.botId = opts.botId ?? "";
    this.credentials = {
      appId: opts.appId,
      appSecret: opts.appSecret,
      ...(opts.domain ? { domain: opts.domain } : {}),
    };
    this.openApisBase =
      opts.domain === "lark"
        ? "https://open.larksuite.com/open-apis"
        : "https://open.feishu.cn/open-apis";
    this.client = new Lark.Client({
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
    });
  }

  private getClient(): Lark.Client {
    if (!this.client) {
      this.client = new Lark.Client({
        appId: this.credentials.appId,
        appSecret: this.credentials.appSecret,
      });
    }
    return this.client;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.tenantTokenCache &&
      this.tenantTokenCache.expiresAtMs - now > 60_000
    ) {
      return this.tenantTokenCache.token;
    }

    const resp = await fetch(
      `${this.openApisBase}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.credentials.appId,
          app_secret: this.credentials.appSecret,
        }),
      },
    );

    const json = (await resp.json().catch(() => null)) as {
      tenant_access_token?: string;
      expire?: number;
      code?: number;
      msg?: string;
    } | null;

    if (!resp.ok || !json?.tenant_access_token) {
      const msg = json?.msg ?? `HTTP ${resp.status}`;
      throw httpStatusError(
        `[FeishuAdapter] Failed to get tenant_access_token: ${msg}`,
        resp.status,
      );
    }

    const expireSec = typeof json.expire === "number" ? json.expire : 3600;
    this.tenantTokenCache = {
      token: json.tenant_access_token,
      expiresAtMs: now + expireSec * 1000,
    };
    return json.tenant_access_token;
  }

  private async feishuGet<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const token = await this.getTenantAccessToken();
    const url = new URL(`${this.openApisBase}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    const json = (await resp.json().catch(() => null)) as any;

    if (!resp.ok || (typeof json?.code === "number" && json.code !== 0)) {
      const msg = json?.msg ?? `HTTP ${resp.status}`;
      throw httpStatusError(
        `[FeishuAdapter] GET ${path} failed: ${msg}`,
        resp.status,
      );
    }
    return json as T;
  }

  /**
   * Upload a local image file to Feishu and get the image_key
   * @param imagePath Absolute path to the local image file
   * @returns Feishu image_key for sending image messages
   */
  async uploadImage(imagePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();

    // Read file from local path (Tauri mode: absolute path)
    const fs = await import("node:fs/promises");
    await fs.access(imagePath).catch(() => {
      throw new Error(`[FeishuAdapter] Image file not found: ${imagePath}`);
    });
    const fileBuffer = await fs.readFile(imagePath);

    // Check file size (Feishu limit: 20MB)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      throw new Error(
        `[FeishuAdapter] Image too large (${fileBuffer.length} bytes), max 20MB`,
      );
    }

    // Determine content type from extension
    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
    const contentTypeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const contentType = contentTypeMap[ext] ?? "image/png";
    const filename = imagePath.split("/").pop() ?? "image.png";

    // Use FormData API for multipart upload (compatible with Tauri/browser environments)
    const formData = new FormData();
    formData.append("image_type", "message");
    formData.append(
      "image",
      new Blob([fileBuffer], { type: contentType }),
      filename,
    );

    const resp = await fetch(`${this.openApisBase}/im/v1/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    const json = (await resp.json().catch(() => null)) as {
      code?: number;
      msg?: string;
      data?: { image_key?: string };
    } | null;

    if (!resp.ok || json?.code !== 0 || !json?.data?.image_key) {
      const msg = json?.msg ?? `HTTP ${resp.status}`;
      throw httpStatusError(
        `[FeishuAdapter] uploadImage failed: ${msg}`,
        resp.status,
      );
    }

    if (DEBUG) {
      console.log(
        `[FeishuAdapter] Uploaded image ${imagePath} -> ${json.data.image_key}`,
      );
    }
    return json.data.image_key;
  }

  /**
   * Send an image message using the image_key from uploadImage
   */
  private async sendImageMessage(
    receiveId: string,
    imageKey: string,
    rootId?: string,
  ): Promise<void> {
    const client = this.getClient();
    const response = await (client.im.v1.message.create as any)({
      params: { receive_id_type: detectReceiveIdType(receiveId) },
      data: {
        receive_id: receiveId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
        ...(rootId ? { root_id: rootId } : {}),
      },
    });
    assertFeishuMessageCreateSucceeded(response, "sendImageMessage", "image");

    if (DEBUG) {
      console.log(`[FeishuAdapter] Sent image to ${receiveId}`);
    }
  }

  /**
   * Separate messages into text and image groups
   */
  private separateMessages(messages: Messages): {
    texts: string[];
    images: Image[];
  } {
    const texts: string[] = [];
    const images: Image[] = [];

    for (const m of messages) {
      if (isPlainText(m)) {
        texts.push(m);
      } else if (isImageMessage(m)) {
        images.push(m);
      } else {
        texts.push("[Content]");
      }
    }

    return { texts, images };
  }

  /**
   * Send text messages as a single Feishu text/post payload
   */
  private async sendTextPayload(
    receiveId: string,
    text: string,
    rootId?: string,
  ): Promise<void> {
    const client = this.getClient();
    const payloads = buildFeishuPayloads(text);
    let lastError: unknown;

    for (const payload of payloads) {
      try {
        const response = await (client.im.v1.message.create as any)({
          params: { receive_id_type: detectReceiveIdType(receiveId) },
          data: {
            receive_id: receiveId,
            msg_type: payload.msg_type,
            content: payload.content,
            ...(rootId ? { root_id: rootId } : {}),
          },
        });
        assertFeishuMessageCreateSucceeded(
          response,
          "sendTextPayload",
          payload.msg_type,
        );
        if (DEBUG) {
          console.log(
            `[FeishuAdapter] Sent text to ${receiveId} as ${payload.msg_type}`,
          );
        }
        return;
      } catch (err) {
        lastError = err;
        if (DEBUG) {
          console.warn(
            `[FeishuAdapter] Text payload failed, trying next: ${err}`,
          );
        }
      }
    }

    throw lastError ?? new Error("Failed to send text message");
  }

  private async feishuGetBinary(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<{ data: string; mimeType: string }> {
    const token = await this.getTenantAccessToken();
    const url = new URL(`${this.openApisBase}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      throw httpStatusError(
        `[FeishuAdapter] GET(binary) ${path} failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
    const mimeType = resp.headers.get("content-type") || "image/jpeg";
    const ab = await resp.arrayBuffer();
    const data = (globalThis.Buffer ?? Buffer).from(ab).toString("base64");
    return { data, mimeType };
  }

  /**
   * Feishu uses chat_id as conversation identifier (both private and group chats have chat_id)
   * detectReceiveIdType dynamically selects receive_id_type based on ID prefix (ou_ -> open_id, oc_ -> chat_id).
   */
  async sendMessages(
    target: MessageTarget,
    id: string,
    messages: Messages,
  ): Promise<void> {
    await this.runWithAdapterError("sendMessages", async () => {
      const { texts, images } = this.separateMessages(messages);

      // Send text messages if any
      if (texts.length > 0) {
        const text = texts.join("\n").trim();
        if (text) {
          await this.sendTextPayload(id, text);
        }
      }

      // Send image messages if any
      for (const image of images) {
        const imagePath = image.path;
        if (!imagePath) {
          console.warn(
            "[FeishuAdapter] Image has no local path, skipping:",
            image.url,
          );
          continue;
        }

        try {
          const imageKey = await this.uploadImage(imagePath);
          await this.sendImageMessage(id, imageKey);
        } catch (err) {
          console.error("[FeishuAdapter] Failed to send image:", err);
          // Continue sending other images even if one fails
        }
      }
    });
  }

  async replyMessages(
    event: MessageEvent,
    messages: Messages,
    _quoteOrigin = false,
  ): Promise<void> {
    await this.runWithAdapterError("replyMessages", async () => {
      const chatId =
        event.sourcePlatformObject?.event?.message?.chat_id ??
        event.sourcePlatformObject?.message?.chat_id;
      const messageId =
        event.sourcePlatformObject?.event?.message?.message_id ??
        event.sourcePlatformObject?.message?.message_id;
      if (!chatId) {
        await this.sendMessages(
          event.targetType,
          (event.sender as Friend).id as string,
          messages,
        );
        return;
      }

      const { texts, images } = this.separateMessages(messages);
      let lastError: unknown;

      // Send text messages if any
      if (texts.length > 0) {
        const text = texts.join("\n").trim();
        if (text) {
          try {
            await this.sendTextPayload(chatId, text, messageId);
          } catch (err) {
            lastError = err;
          }
        }
      }

      // Send image messages if any
      for (const image of images) {
        const imagePath = image.path;
        if (!imagePath) {
          console.warn(
            "[FeishuAdapter] Reply image has no local path, skipping:",
            image.url,
          );
          continue;
        }

        try {
          const imageKey = await this.uploadImage(imagePath);
          await this.sendImageMessage(chatId, imageKey, messageId);
        } catch (err) {
          console.error("[FeishuAdapter] Failed to send reply image:", err);
          lastError = err;
          // Continue sending other images even if one fails
        }
      }

      if (lastError) {
        throw lastError;
      }
    });
  }

  /**
   * Use Feishu "Get conversation list of user or bot" API to get conversation names (group + private)
   * Reference: https://open.feishu.cn/document/server-docs/im-v1/chat/list
   */
  async listChatsForInsights(): Promise<
    Array<{
      chatId: string;
      chatName?: string | null;
      chatType: "p2p" | "group" | "unknown";
    }>
  > {
    const chats: Array<{
      chatId: string;
      chatName?: string | null;
      chatType: "p2p" | "group" | "unknown";
    }> = [];

    let pageToken: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const resp = await this.feishuGet<{
          data?: { items?: any[]; has_more?: boolean; page_token?: string };
        }>("/im/v1/chats", {
          page_size: 50,
          page_token: pageToken,
        });

        const items: any[] = Array.isArray(resp?.data?.items)
          ? (resp.data?.items as any[])
          : [];

        if (items.length === 0) {
          break;
        }

        for (const c of items) {
          const chatId: string | undefined = c.chat_id ?? c.id;
          if (!chatId) continue;
          const name: string | undefined =
            c.name ?? c.chat_name ?? c.display_name ?? chatId;
          const mode = (c.chat_mode ?? c.chat_type ?? "unknown") as string;
          const chatType: "p2p" | "group" | "unknown" =
            mode === "p2p" ? "p2p" : mode === "group" ? "group" : "unknown";

          chats.push({
            chatId,
            chatName: name,
            chatType,
          });
        }

        if (!resp?.data?.has_more) {
          break;
        }
        const nextToken = resp?.data?.page_token;
        if (!nextToken || typeof nextToken !== "string") {
          break;
        }
        pageToken = nextToken;
      } catch (err) {
        console.error(
          "[FeishuAdapter] Failed to get conversation list (/im/v1/chats), will fall back to contact table:",
          err,
        );
        break;
      }
    }

    if (DEBUG)
      console.log(
        `[FeishuAdapter] Retrieved ${chats.length} conversations via /im/v1/chats`,
      );

    return chats;
  }

  /**
   * Current app bot open_id, used to identify which messages in group history were sent by the bot
   */
  async getBotOpenId(): Promise<string | null> {
    if (this.botOpenIdMemo !== undefined) {
      return this.botOpenIdMemo;
    }
    try {
      const resp = await this.feishuGet<{
        data?: { bot?: { open_id?: string } };
      }>("/bot/v3/info");
      const raw = resp?.data?.bot?.open_id?.trim();
      this.botOpenIdMemo = raw && raw.length > 0 ? raw : null;
      return this.botOpenIdMemo;
    } catch (err) {
      console.warn("[FeishuAdapter] bot/v3/info failed:", err);
      this.botOpenIdMemo = null;
      return null;
    }
  }

  async downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    const mid = messageId?.trim();
    const ik = imageKey?.trim();
    if (!mid || !ik) return null;

    const tryKeys = new Set<string>([ik]);
    for (const key of await this.getMessageImageKeys(mid)) {
      const trimmed = key.trim();
      if (trimmed) tryKeys.add(trimmed);
    }

    for (const key of tryKeys) {
      try {
        return await this.feishuGetBinary(
          `/im/v1/messages/${encodeURIComponent(mid)}/resources/${encodeURIComponent(key)}`,
          { type: "image" },
        );
      } catch {
        // try next key while keeping message_id binding strict
      }
    }

    return null;
  }

  async getMessageImageKeys(messageId: string): Promise<string[]> {
    const mid = messageId?.trim();
    if (!mid) return [];

    const extract = (raw: string): string[] => {
      if (!raw?.trim()) return [];
      const out = new Set<string>();
      const imageKeyRegex = /"image_key"\s*:\s*"([^"]+)"/g;
      const fileKeyRegex = /"file_key"\s*:\s*"([^"]+)"/g;
      for (const regex of [imageKeyRegex, fileKeyRegex]) {
        let m: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((m = regex.exec(raw)) != null) {
          const key = m[1]?.trim();
          if (key) out.add(key);
        }
      }
      return [...out];
    };

    try {
      const resp = await this.feishuGet<any>(
        `/im/v1/messages/${encodeURIComponent(mid)}`,
      );
      const content =
        (typeof resp?.data?.items?.[0]?.body?.content === "string" &&
          resp.data.items[0].body.content) ||
        (typeof resp?.data?.items?.[0]?.content === "string" &&
          resp.data.items[0].content) ||
        (typeof resp?.data?.body?.content === "string" &&
          resp.data.body.content) ||
        (typeof resp?.data?.content === "string" && resp.data.content) ||
        "";
      return extract(content);
    } catch {
      return [];
    }
  }

  /**
   * Paginated fetch of conversation messages, starting from sinceSec (Unix seconds, inclusive); paginate from newest to oldest until past that time or no more pages.
   * Used to backfill up to 3 days of history after @ activation.
   */
  async fetchChatMessagesSince(options: {
    chatId: string;
    chatType: "p2p" | "group";
    /** Inclusive lower bound */
    sinceSec: number;
    /** Prevent infinite loop on errors */
    maxPages?: number;
  }): Promise<
    Array<
      ExtractedMessageInfo & {
        quoteIds: string[];
        imageKeys: string[];
        senderName?: string;
      }
    >
  > {
    const { chatId, chatType: ct, sinceSec, maxPages = 500 } = options;
    if (!chatId) return [];

    const client = this.getClient();
    const inferredChatType: "private" | "group" | "channel" | "unknown" =
      ct === "group" ? "group" : "private";

    let pageToken: string | undefined;
    let page = 0;
    const allMessages: Array<
      ExtractedMessageInfo & {
        quoteIds: string[];
        imageKeys: string[];
        senderName?: string;
      }
    > = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (page >= maxPages) {
        console.warn(
          `[FeishuAdapter] fetchChatMessagesSince hit maxPages=${maxPages} chatId=${chatId}`,
        );
        break;
      }
      page++;
      try {
        const resp: any = await (client as any).im.v1.message.list({
          params: {
            container_id_type: "chat",
            container_id: chatId,
            page_size: 50,
            sort_type: "ByCreateTimeDesc",
            page_token: pageToken,
          },
        });

        const data = resp?.data;
        const items: any[] = Array.isArray(data?.items) ? data.items : [];

        if (items.length === 0) {
          break;
        }

        let reachedOlderThanSince = false;

        for (const item of items) {
          const createTimeRaw = item.create_time ?? item.create_time_ms;
          let createTimeMs = Number(createTimeRaw ?? 0);
          if (!Number.isFinite(createTimeMs) || createTimeMs <= 0) {
            continue;
          }
          if (createTimeMs < 1e11) {
            createTimeMs = createTimeMs * 1000;
          }
          const tsSec = Math.floor(createTimeMs / 1000);
          if (tsSec < sinceSec) {
            reachedOlderThanSince = true;
            break;
          }

          const contentStr: string =
            typeof item.content === "string"
              ? item.content
              : typeof item.body?.content === "string"
                ? item.body.content
                : "";
          const parsed = extractContentInfo(contentStr);
          const rawMsgType = String(item.message_type ?? item.msg_type ?? "");
          const imageKeys =
            parsed.imageKeys.length > 0
              ? parsed.imageKeys
              : rawMsgType === "image"
                ? extractImageKeysFromRawContent(contentStr)
                : [];
          const normalizedText = parsed.text || "[Image message]";
          if (!parsed.text && imageKeys.length === 0) continue;
          const quoteIdSet = new Set<string>(parsed.quoteIds);
          if (typeof item.parent_id === "string" && item.parent_id.trim()) {
            quoteIdSet.add(item.parent_id.trim());
          }
          if (typeof item.root_id === "string" && item.root_id.trim()) {
            quoteIdSet.add(item.root_id.trim());
          }
          if (DEBUG) {
            console.log(
              "[FeishuAdapter][DEBUG_PARSE] history chat_id=%s message_id=%s quote_ids=%s parsed_preview=%s",
              chatId,
              String(item.message_id ?? "(empty)"),
              [...quoteIdSet].join(",") || "(none)",
              normalizedText.replace(/\s+/g, " ").slice(0, 180),
            );
          }

          const senderInfo: any =
            item.sender ??
            item.sender_id ??
            item.sender_id?.open_id ??
            item.sender_id?.user_id ??
            {};
          const senderId: string =
            senderInfo.open_id ??
            senderInfo.user_id ??
            senderInfo.id ??
            "unknown";
          const senderName: string | undefined =
            typeof senderInfo.sender_name === "string"
              ? senderInfo.sender_name
              : typeof senderInfo.name === "string"
                ? senderInfo.name
                : typeof senderInfo.display_name === "string"
                  ? senderInfo.display_name
                  : undefined;

          allMessages.push({
            id: item.message_id ?? `${chatId}_${createTimeMs}`,
            chatType: inferredChatType,
            chatName: chatId,
            sender: senderId,
            senderName,
            text: normalizedText,
            quoteIds: [...quoteIdSet],
            imageKeys,
            timestamp: tsSec,
          });
        }

        if (reachedOlderThanSince) {
          break;
        }

        if (!data?.has_more) {
          break;
        }
        const nextToken = data.page_token;
        if (!nextToken || typeof nextToken !== "string") {
          break;
        }
        pageToken = nextToken;
      } catch (err) {
        console.error(
          `[FeishuAdapter] fetchChatMessagesSince failed chatId=${chatId}:`,
          err,
        );
        break;
      }
    }

    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    if (DEBUG) {
      console.log(
        `[FeishuAdapter] fetchChatMessagesSince chatId=${chatId} sinceSec=${sinceSec} count=${allMessages.length}`,
      );
    }

    return allMessages;
  }

  async getChatNameById(chatId: string): Promise<string | null> {
    if (!chatId) return null;
    try {
      const resp = await this.feishuGet<{
        data?: { name?: string; chat_name?: string; display_name?: string };
      }>(`/im/v1/chats/${encodeURIComponent(chatId)}`);
      const name =
        resp?.data?.name ?? resp?.data?.chat_name ?? resp?.data?.display_name;
      return typeof name === "string" && name.trim().length > 0 ? name : null;
    } catch (err) {
      if (DEBUG) {
        console.warn(
          `[FeishuAdapter] Failed to get conversation details chatId=${chatId}`,
          err,
        );
      }
      return null;
    }
  }

  /**
   * Batch fetch historical messages by conversation for scheduled Insight generation
   * @param options.chats List of conversations to fetch
   * @param options.since Start Unix timestamp (seconds), only keep messages after this
   * @param options.maxMessagesPerChat Maximum number of messages to fetch per conversation
   */
  async getMessagesByChats(options: {
    chats: Array<{
      chatId: string;
      chatName?: string | null;
      chatType?: "p2p" | "group" | "unknown";
    }>;
    since: number;
    maxMessagesPerChat?: number;
  }): Promise<ExtractedMessageInfo[]> {
    const { chats, since, maxMessagesPerChat = 200 } = options;
    const client = this.getClient();
    const allMessages: ExtractedMessageInfo[] = [];

    for (const chat of chats) {
      const chatId = chat.chatId;
      if (!chatId) continue;

      let pageToken: string | undefined;
      let fetchedCount = 0;

      // Fetch historical messages for specified conversation page by page
      // Use reverse order by creation time, start from newest message and work backwards
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const resp: any = await (client as any).im.v1.message.list({
            params: {
              container_id_type: "chat",
              container_id: chatId,
              page_size: 50,
              // ByCreateTimeDesc: Reverse order by creation time (newest first)
              sort_type: "ByCreateTimeDesc",
              page_token: pageToken,
            },
          });

          const data = resp?.data;
          const items: any[] = Array.isArray(data?.items) ? data.items : [];

          if (items.length === 0) {
            break;
          }

          let reachedOlderThanSince = false;

          for (const item of items) {
            // create_time might be millisecond timestamp string or second-level timestamp, handle both cases
            const createTimeRaw = item.create_time ?? item.create_time_ms;
            let createTimeMs = Number(createTimeRaw ?? 0);
            if (!Number.isFinite(createTimeMs) || createTimeMs <= 0) {
              continue;
            }
            // If value is relatively small (e.g., around 10 digits), it's more likely a second-level timestamp, need to convert to milliseconds
            if (createTimeMs < 1e11) {
              createTimeMs = createTimeMs * 1000;
            }
            const tsSec = Math.floor(createTimeMs / 1000);
            if (tsSec < since) {
              // Current item and subsequent items are earlier than since, mark and break current page loop
              reachedOlderThanSince = true;
              break;
            }

            const contentStr: string =
              typeof item.content === "string"
                ? item.content
                : typeof item.body?.content === "string"
                  ? item.body.content
                  : "";
            const parsed = extractContentInfo(contentStr);
            const rawMsgType = String(item.message_type ?? item.msg_type ?? "");
            const imageKeys =
              parsed.imageKeys.length > 0
                ? parsed.imageKeys
                : rawMsgType === "image"
                  ? extractImageKeysFromRawContent(contentStr)
                  : [];
            const text = parsed.text || "[Image message]";
            if (!parsed.text && imageKeys.length === 0) continue;
            if (DEBUG) {
              console.log(
                "[FeishuAdapter][DEBUG_PARSE] list chat_id=%s message_id=%s quote_ids=%s parsed_preview=%s",
                chatId,
                String(item.message_id ?? "(empty)"),
                parsed.quoteIds.join(",") || "(none)",
                parsed.text.replace(/\s+/g, " ").slice(0, 180),
              );
            }

            const senderInfo: any =
              item.sender ??
              item.sender_id ??
              item.sender_id?.open_id ??
              item.sender_id?.user_id ??
              {};
            const senderId: string =
              senderInfo.open_id ??
              senderInfo.user_id ??
              senderInfo.id ??
              "unknown";

            const chatType: "private" | "group" | "channel" | "unknown" =
              chat.chatType === "group"
                ? "group"
                : chat.chatType === "p2p"
                  ? "private"
                  : item.chat_type === "group"
                    ? "group"
                    : "private";

            allMessages.push({
              id: item.message_id ?? `${chatId}_${createTimeMs}`,
              chatType,
              chatName: chat.chatName ?? chatId,
              sender: senderId,
              text,
              attachments:
                imageKeys.length > 0
                  ? imageKeys.map((k) => ({
                      name: `image-${k}`,
                      url: `feishu://image/${k}`,
                      contentType: "image/*",
                      source: "feishu",
                    }))
                  : undefined,
              timestamp: tsSec,
            });

            fetchedCount++;
            if (fetchedCount >= maxMessagesPerChat) {
              break;
            }
          }

          if (fetchedCount >= maxMessagesPerChat) {
            break;
          }

          // Already encountered message earlier than since, subsequent pagination will only be older, end directly
          if (reachedOlderThanSince) {
            break;
          }

          if (!data?.has_more) {
            break;
          }
          const nextToken = data.page_token;
          if (!nextToken || typeof nextToken !== "string") {
            break;
          }
          pageToken = nextToken;
        } catch (err) {
          console.error(
            `[FeishuAdapter] Failed to fetch historical messages for conversation ${chatId}:`,
            err,
          );
          break;
        }
      }

      if (DEBUG)
        console.log(
          `[FeishuAdapter] Collected ${fetchedCount} messages for summary from conversation ${chatId}`,
        );
    }

    if (DEBUG)
      console.log(
        `[FeishuAdapter] [Bot ${this.botId}] Collected ${allMessages.length} Feishu messages for scheduled Insight`,
      );

    return allMessages;
  }

  /** Empty implementation when no long-connection resources need to be released */
  async kill(): Promise<void> {
    this.client = null;
  }
}

/**
 * Build Friend from Feishu event (private chat sender)
 */
export function feishuEventToFriend(openId: string, name?: string): Friend {
  return {
    id: openId,
    name: name ?? openId,
    nickname: name,
  };
}

/**
 * Build Group + GroupMember from Feishu event (group chat sender)
 */
export function feishuEventToGroupMember(
  openId: string,
  chatId: string,
  chatName?: string,
  memberName?: string,
): GroupMember {
  const group: Group = {
    id: chatId,
    name: chatName ?? chatId,
    permission: Permission.Member,
  };
  return {
    id: openId,
    memberName: memberName ?? openId,
    permission: Permission.Member,
    group,
    // Fields below are not used in current scenario, fill with reasonable defaults
    specialTitle: "",
    joinTimestamp: new Date(0),
    lastSpeakTimestamp: new Date(0),
    muteTimeRemaining: 0,
  };
}
