/**
 * Extract raw message data from various platform formats
 * This module provides utility functions to extract message data
 * during insight generation for storage in IndexedDB
 */

/**
 * Coerce a `LooseValue` to an array (used for attachment / file lists).
 * Returns `undefined` when the value isn't an array.
 */
function toArray(value: LooseValue): unknown[] | undefined {
	return Array.isArray(value) ? (value as unknown[]) : undefined;
}

/**
 * Loose value shape used while extracting from untyped platform payloads.
 * Each access can return any of these shapes; the callers coerce as needed.
 */
type LooseValue = string | number | boolean | null | undefined | object | LooseValue[];

/**
 * Loose record shape used while extracting from untyped platform payloads.
 * We index through arbitrary keys to mirror the original `any` behaviour
 * while staying inside `noExplicitAny`. The shape is recursive so that
 * nested objects (e.g. `msg.body.content`, `msg.from.email`) keep working.
 */
type LooseRecord = { [key: string]: LooseValue };

/**
 * Coerce a record value to a non-empty string, falling back when the
 * underlying payload contains an unexpected primitive (e.g. number/boolean).
 */
function coerceString(value: LooseValue, fallback: string): string {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

/**
 * Coerce a `content`-style record value to a string suitable for hashing.
 * Anything that isn't a string falls back to its stringified form.
 */
function coerceContent(value: LooseValue): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export interface RawMessageData {
	messageId: string;
	platform: string;
	botId: string;
	channel?: string;
	person?: string;
	timestamp: number;
	content: string;
	attachments?: Array<{
		name: string;
		url: string;
		contentType?: string;
		sizeBytes?: number;
	}>;
	metadata?: Record<string, unknown>;
}

/**
 * Extract raw messages from Slack format
 */
export function extractSlackMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.ts || msg.timestamp || msg.time;
			const content = String(msg.text || msg.content || msg.message || msg.snippet || "");
			const channel = String(msg.channel || msg.chatName || msg.chatId || "unknown");
			const sender = String(msg.user || msg.userName || msg.sender || msg.from || "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.clientMsgId || msg.msgId) {
				messageId = String(msg.clientMsgId || msg.msgId);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `slack_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "slack",
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content: String(content),
				attachments: extractAttachments(toArray(msg.attachments), toArray(msg.files)),
				metadata: {
					slackTs: msg.ts,
					threadTs: msg.threadTs,
					replyCount: msg.replyCount,
				},
			};
		});
}

/**
 * Extract raw messages from Discord format
 */
export function extractDiscordMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.timestamp || msg.createdTimestamp;
			const contentRaw = msg.content || msg.message || msg.text || msg.snippet || "";
			const content = coerceContent(contentRaw);
			const channel = coerceString(msg.channelName || msg.channelId || msg.guildId, "unknown");
			const sender = coerceString(msg.authorName || msg.authorUsername || msg.userName, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `discord_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "discord",
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					guildId: msg.guildId,
					channelId: msg.channelId,
				},
			};
		});
}

/**
 * Extract raw messages from Feishu/DingTalk: Message is in ExtractedMessageInfo format, write to IndexedDB original record
 */
export function extractUnifiedInsightMessages(
	messages: unknown[],
	platform: "feishu" | "dingtalk",
	botId: string,
): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown) => {
			const msg = rawMsg as LooseRecord;
			const content = String(msg.text ?? msg.content ?? msg.message ?? "");
			const channel = String(msg.chatName ?? msg.chatId ?? "unknown");
			const sender = String(msg.sender ?? "unknown");
			const idRaw = msg.id;
			const tsRaw = msg.timestamp ?? msg.ts ?? 0;
			const tsNum = typeof tsRaw === "number" ? tsRaw : Number(tsRaw) || 0;

			// ExtractedMessageInfo and part pipeline use second-level timestamp; IndexedDB display layer handles seconds
			const timestampSec = tsNum >= 1e12 ? Math.floor(tsNum / 1000) : Math.floor(tsNum);

			let messageId: string;
			if (idRaw !== undefined && idRaw !== null && idRaw !== "") {
				messageId = String(idRaw);
			} else {
				const contentHash = content
					? btoa(encodeURIComponent(content.substring(0, 100))).substring(0, 16)
					: "";
				messageId = `${platform}_${botId}_${timestampSec}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform,
				botId,
				channel,
				person: sender,
				timestamp: timestampSec > 0 ? timestampSec : Math.floor(Date.now() / 1000),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					chatType: msg.chatType,
				},
			};
		});
}

/**
 * Extract raw messages from Telegram format
 */
export function extractTelegramMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.date || msg.timestamp || msg.time;
			const content = coerceContent(msg.text || msg.message || msg.content || msg.snippet);
			const chatId = coerceString(msg.chatName || msg.chatTitle || msg.chatId, "unknown");
			const sender = coerceString(msg.fromName || msg.fromFirstName || msg.sender, "unknown");

			// Generate unique messageId using combination of fields
			// Use msg.id if available, otherwise create a unique composite key
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				// Create a hash from content to ensure uniqueness for same-timestamp messages
				const contentHash = content
					? btoa(encodeURIComponent(content.substring(0, 100))).substring(0, 16)
					: "";
				messageId = `telegram_${botId}_${String(timestamp)}_${chatId}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "telegram",
				botId,
				channel: chatId,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					chatId: msg.chatId,
					fromId: msg.fromId,
				},
			};
		});
}

/**
 * Extract raw messages from WhatsApp format
 */
export function extractWhatsAppMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const keyRecord = msg.key as LooseRecord | undefined;
			const timestamp = msg.timestamp || msg.time || msg.date;
			const content = coerceContent(msg.body || msg.text || msg.message || msg.content);
			const channel = coerceString(msg.chatName || msg.from || msg.chatId, "unknown");
			const sender = coerceString(msg.author || msg.sender || msg.pushName, "unknown");

			// Generate unique messageId
			let messageId: string;
			const keyId = keyRecord?.id;
			if (msg.id || keyId) {
				messageId = String(msg.id || keyId);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `whatsapp_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "whatsapp",
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					fromMe: msg.fromMe,
					remoteJid: keyRecord?.remoteJid,
				},
			};
		});
}

/**
 * Extract raw messages from iMessage format
 */
export function extractIMessageMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.timestamp || msg.time || msg.date;
			const content = coerceContent(msg.text || msg.message || msg.content);
			const channel = coerceString(msg.chatName || msg.chat_id || msg.chatId, "unknown");
			const sender = msg.isFromMe ? "Me" : coerceString(msg.sender || msg.from, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = `imessage_${String(msg.id)}`;
			} else {
				const contentHash = content
					? btoa(encodeURIComponent(content.substring(0, 100))).substring(0, 16)
					: "";
				messageId = `imessage_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "imessage",
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					chatId: msg.chatId || msg.chat_id,
					isFromMe: msg.isFromMe || msg.is_from_me,
					isGroupChat: msg.isGroupChat || msg.is_group_chat,
				},
			};
		});
}

/**
 * Extract raw messages from Email format (Gmail/Outlook)
 */
export function extractEmailMessages(
	emails: unknown[],
	platform: "gmail" | "outlook",
	botId: string,
): RawMessageData[] {
	if (!Array.isArray(emails)) {
		return [];
	}

	return emails
		.filter((email) => email && typeof email === "object")
		.map((rawEmail: unknown, _index: number) => {
			const email = rawEmail as LooseRecord;
			const fromRecord = email.from as LooseRecord | undefined;
			const timestamp = email.timestamp || email.date || email.time || Math.floor(Date.now() / 1000);
			const content = coerceContent(email.text || email.snippet || email.subject || email.body);
			const channel = coerceString(fromRecord?.email || email.sender || email.fromEmail, "unknown");
			const sender = coerceString(fromRecord?.name || email.senderName || email.fromName, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (email.uid || email.id) {
				messageId = String(email.uid || email.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `${platform}_${botId}_${String(timestamp || 0)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform,
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(email.attachments)),
				metadata: {
					subject: email.subject,
					to: email.to,
					cc: email.cc,
					bcc: email.bcc,
				},
			};
		});
}

/**
 * Extract raw messages from Teams format
 */
export function extractTeamsMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const bodyRecord = msg.body as LooseRecord | undefined;
			const fromRecord = msg.from as LooseRecord | undefined;
			const userRecord = fromRecord?.user as LooseRecord | undefined;
			const timestamp = msg.timestamp || msg.createdDateTime || msg.time;
			const content = coerceContent(bodyRecord?.content || msg.content || msg.text);
			const channel = coerceString(msg.channelName || msg.chatName || msg.channelId, "unknown");
			const sender = coerceString(userRecord?.displayName || msg.senderName || msg.userName, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `teams_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "teams",
				botId,
				channel,
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					channelId: msg.channelId,
					teamId: msg.teamId,
				},
			};
		});
}

/**
 * Extract raw messages from LinkedIn format
 */
export function extractLinkedInMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.timestamp || msg.createdTime || msg.time;
			const content = coerceContent(msg.body || msg.text || msg.message || msg.content);
			const channel = coerceString(msg.chatName || msg.from, "unknown");
			const sender = coerceString(msg.senderName || msg.author, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `linkedin_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "linkedin",
				botId,
				channel: String(msg.chatName || msg.conversationId || ""),
				person: String(msg.senderName || msg.author || msg.from || ""),
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					conversationId: msg.conversationId,
				},
			};
		});
}

/**
 * Extract raw messages from Instagram format
 */
export function extractInstagramMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.timestamp || msg.createdTime || msg.time;
			const content = coerceContent(msg.text || msg.message || msg.content);
			const channel = coerceString(msg.chatName || msg.conversationId, "unknown");
			const sender = coerceString(msg.username || msg.senderName || msg.from, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `instagram_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "instagram",
				botId,
				channel: String(msg.chatName || msg.conversationId || ""),
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments)),
				metadata: {
					conversationId: msg.conversationId,
				},
			};
		});
}

/**
 * Extract raw messages from X (Twitter) format
 */
export function extractXMessages(messages: unknown[], botId: string): RawMessageData[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.filter((msg) => msg && typeof msg === "object")
		.map((rawMsg: unknown, _index: number) => {
			const msg = rawMsg as LooseRecord;
			const timestamp = msg.timestamp || msg.createdTime || msg.time;
			const content = coerceContent(msg.text || msg.message || msg.content);
			const channel = coerceString(msg.chatName || msg.conversationId, "unknown");
			const sender = coerceString(msg.username || msg.senderName || msg.from, "unknown");

			// Generate unique messageId
			let messageId: string;
			if (msg.id) {
				messageId = String(msg.id);
			} else {
				const contentHash = content ? btoa(content.substring(0, 100)).substring(0, 16) : "";
				messageId = `twitter_${botId}_${String(timestamp)}_${channel}_${sender}_${contentHash}`;
			}

			return {
				messageId,
				platform: "twitter",
				botId,
				channel: String(msg.chatName || msg.conversationId || ""),
				person: sender,
				timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
				content,
				attachments: extractAttachments(toArray(msg.attachments), toArray(msg.media)),
				metadata: {
					conversationId: msg.conversationId,
				},
			};
		});
}

/**
 * Extract raw messages from RSS feed format
 */
export function extractRSSMessages(items: unknown[], botId: string, feedTitle?: string): RawMessageData[] {
	if (!Array.isArray(items)) {
		return [];
	}

	return items
		.filter((item) => item && typeof item === "object")
		.map((rawItem: unknown, _index: number) => {
			const item = rawItem as LooseRecord;
			const timestamp = item.pubDate || item.publishedAt || item.date || item.isoDate;
			const parsedTimestamp = timestamp ? new Date(String(timestamp)).getTime() / 1000 : Date.now() / 1000;

			// Extract content from various RSS fields
			const content = item["content:encoded"] || item.content || item.summary || item.description || "";
			const title = item.title || item.titleText || "";

			// Combine title and content for better context
			const fullContent = title ? `${title}\n\n${content}` : String(content || "");

			// Extract author from various fields
			const author = item.creator || item.author || item["dc:creator"] || "";
			const person =
				typeof author === "string" ? author : (author as { name?: string } | undefined)?.name || "";

			// Extract link/URL
			const link = String(item.link || item.guid || item.url || "");

			// Extract categories/tags
			const categories = item.categories || item.tags || [];
			const categoryList = Array.isArray(categories)
				? categories
						.map((c: unknown) =>
							typeof c === "string" ? c : (c as { name?: unknown })?.name || (c as { term?: unknown })?.term,
						)
						.filter(Boolean)
				: [];

			// Generate unique messageId
			let messageId: string;
			if (item.guid || item.id || item.link) {
				messageId = String(item.guid || item.id || item.link);
			} else {
				const contentHash = fullContent
					? btoa(encodeURIComponent(String(fullContent)).substring(0, 100)).substring(0, 16)
					: "";
				messageId = `rss_${botId}_${parsedTimestamp}_${feedTitle || "feed"}_${person || "unknown"}_${contentHash}`;
			}

			return {
				messageId,
				platform: "rss",
				botId,
				channel: String(feedTitle || item.feedTitle || "RSS Feed"),
				person: person || feedTitle || "Unknown",
				timestamp: typeof parsedTimestamp === "number" ? parsedTimestamp : Date.now() / 1000,
				content: String(fullContent).trim(),
				attachments: link
					? [
							{
								name: title ? `${String(title).substring(0, 50)}...` : "Article",
								url: link,
								contentType: "text/html",
							},
						]
					: undefined,
				metadata: {
					title: title,
					link: link,
					categories: categoryList,
					pubDate: item.pubDate,
					feedTitle: feedTitle || item.feedTitle,
				},
			};
		});
}

/**
 * Helper function to extract attachments from various formats
 */
function extractAttachments(
	attachments?: unknown[],
	files?: unknown[],
): Array<{
	name: string;
	url: string;
	contentType?: string;
	sizeBytes?: number;
}> {
	const result: Array<{
		name: string;
		url: string;
		contentType?: string;
		sizeBytes?: number;
	}> = [];

	// Process attachments array
	if (Array.isArray(attachments)) {
		for (const attachment of attachments) {
			if (!attachment || typeof attachment !== "object") continue;

			const att = attachment as LooseRecord;
			if (att.url || att.link || att.permalink) {
				result.push({
					name: (att.name as string) || (att.filename as string) || (att.title as string) || "attachment",
					url: (att.url as string) || (att.link as string) || (att.permalink as string),
					contentType: (att.mimetype as string) || (att.contentType as string) || (att.type as string),
					sizeBytes: (att.sizeBytes as number) || (att.size as number) || (att.fileSize as number),
				});
			}
		}
	}

	// Process files array (Slack specific)
	if (Array.isArray(files)) {
		for (const file of files) {
			if (!file || typeof file !== "object") continue;

			const f = file as LooseRecord;
			if (f.url_private || f.url_private_download || f.permalink) {
				result.push({
					name: (f.name as string) || (f.filename as string) || (f.title as string) || "file",
					url: (f.url_private as string) || (f.url_private_download as string) || (f.permalink as string),
					contentType: (f.mimetype as string) || (f.filetype as string) || (f.type as string),
					sizeBytes: (f.size as number) || (f.fileSize as number),
				});
			}
		}
	}

	// Process media array (X/Twitter specific)
	if (Array.isArray(files)) {
		for (const media of files) {
			if (!media || typeof media !== "object") continue;

			const m = media as LooseRecord;
			if (m.media_url_https || m.media_url || m.url) {
				result.push({
					name: (m.type as string) || "media",
					url: (m.media_url_https as string) || (m.media_url as string) || (m.url as string),
					contentType: m.type as string,
				});
			}
		}
	}

	return result;
}

/**
 * Universal message extractor - routes to appropriate platform extractor
 */
export function extractRawMessages(
	messages: unknown[] | string,
	platform: string,
	botId: string,
	feedTitle?: string,
): RawMessageData[] {
	// Handle JSON string input
	const messageArray = typeof messages === "string" ? JSON.parse(messages) : messages;

	if (!Array.isArray(messageArray) || messageArray.length === 0) {
		return [];
	}

	switch (platform.toLowerCase()) {
		case "slack":
			return extractSlackMessages(messageArray, botId);
		case "discord":
			return extractDiscordMessages(messageArray, botId);
		case "telegram":
			return extractTelegramMessages(messageArray, botId);
		case "whatsapp":
			return extractWhatsAppMessages(messageArray, botId);
		case "imessage":
			return extractIMessageMessages(messageArray, botId);
		case "gmail":
			return extractEmailMessages(messageArray, "gmail", botId);
		case "outlook":
			return extractEmailMessages(messageArray, "outlook", botId);
		case "teams":
			return extractTeamsMessages(messageArray, botId);
		case "linkedin":
			return extractLinkedInMessages(messageArray, botId);
		case "instagram":
			return extractInstagramMessages(messageArray, botId);
		case "twitter":
		case "x":
			return extractXMessages(messageArray, botId);
		case "rss":
			return extractRSSMessages(messageArray, botId, feedTitle);
		case "feishu":
			return extractUnifiedInsightMessages(messageArray, "feishu", botId);
		case "dingtalk":
			return extractUnifiedInsightMessages(messageArray, "dingtalk", botId);
		default:
			return [];
	}
}
