import { describe, expect, it, vi } from "vitest";
import {
	AppError,
	FileCache,
	MemoCache,
	buildNavigationUrl,
	buildRefMarker,
	cn,
	coerceDate,
	containsMalformedToolCall,
	delay,
	estimateTokens,
	extractMalformedToolCalls,
	extractRefsFromContent,
	filterToolCallText,
	formatBytes,
	formatToLocalTime,
	generateUUID,
	getCurrentTimestamp,
	getCurrentYearMonth,
	getDefaultPrompt,
	getMessageByErrorCode,
	getMostRecentUserMessage,
	getPresetPrompt,
	getRefMarkerRangeBeforeCursor,
	getSelectedSoulPresetId,
	getSoulPresetByPrompt,
	getTextFromMessage,
	getTrailingMessageId,
	isTelegramAuthIssue,
	normalizeTimestamp,
	normalizeUserId,
	parseContentWithRefs,
	sanitizeText,
	stripMalformedToolCalls,
	timeBeforeHours,
	timeBeforeHoursMs,
	timeBeforeMinutes,
	userIdsEqual,
} from "./index";
import { UserLocale } from "./locale/user-locale";

describe("cn", () => {
	it("merges Tailwind classes taking the last conflicting value", () => {
		expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
	});

	it("handles conditional classes", () => {
		expect(cn("base", false && "hidden", true && "block")).toBe("base block");
	});
});

describe("generateUUID", () => {
	it("returns a valid v4-like UUID string", () => {
		const uuid = generateUUID();
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("returns different values on successive calls", () => {
		expect(generateUUID()).not.toBe(generateUUID());
	});
});

describe("getMostRecentUserMessage", () => {
	it("returns the last user message", () => {
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply" },
			{ role: "user", content: "last" },
		] as unknown as Parameters<typeof getMostRecentUserMessage>[0];
		const last = getMostRecentUserMessage(messages) as unknown as { content?: string } | undefined;
		expect(last?.content).toBe("last");
	});

	it("returns undefined when there are no user messages", () => {
		const messages = [{ role: "assistant", content: "hi" }] as unknown as Parameters<
			typeof getMostRecentUserMessage
		>[0];
		expect(getMostRecentUserMessage(messages)).toBeUndefined();
	});
});

describe("getTrailingMessageId", () => {
	it("returns the id of the last message", () => {
		const messages = [{ id: "a" }, { id: "b" }] as unknown as Parameters<
			typeof getTrailingMessageId
		>[0]["messages"];
		expect(getTrailingMessageId({ messages })).toBe("b");
	});

	it("returns null for an empty array", () => {
		expect(getTrailingMessageId({ messages: [] })).toBeNull();
	});
});

describe("sanitizeText", () => {
	it("removes the <has_function_call> marker", () => {
		expect(sanitizeText("Hello<has_function_call> world")).toBe("Hello world");
	});

	it("returns text unchanged when the marker is absent", () => {
		expect(sanitizeText("clean")).toBe("clean");
	});
});

describe("getTextFromMessage", () => {
	it("joins text parts from a chat message", () => {
		const message = {
			role: "assistant",
			parts: [
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world" },
			],
		} as unknown as Parameters<typeof getTextFromMessage>[0];
		expect(getTextFromMessage(message)).toBe("Hello world");
	});

	it("ignores non-text parts", () => {
		const message = {
			role: "assistant",
			parts: [{ type: "text", text: "text" }, { type: "tool-invocation" }],
		} as unknown as Parameters<typeof getTextFromMessage>[0];
		expect(getTextFromMessage(message)).toBe("text");
	});
});

describe("getCurrentTimestamp", () => {
	it("returns the current time in seconds", () => {
		const before = Math.floor(Date.now() / 1000);
		const ts = getCurrentTimestamp();
		const after = Math.floor(Date.now() / 1000);
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});

describe("normalizeTimestamp", () => {
	it("converts second-level timestamps to milliseconds", () => {
		expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
	});

	it("leaves millisecond-level timestamps unchanged", () => {
		expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	it("parses numeric strings", () => {
		expect(normalizeTimestamp("1700000000")).toBe(1_700_000_000_000);
	});

	it("falls back to now for empty or invalid input", () => {
		const before = Date.now();
		expect(normalizeTimestamp(null)).toBeGreaterThanOrEqual(before);
		expect(normalizeTimestamp("not a number")).toBeGreaterThanOrEqual(before);
	});
});

describe("formatToLocalTime", () => {
	it("formats an ISO timestamp", () => {
		const result = formatToLocalTime("2024-01-15T08:30:00.000Z");
		expect(result).toContain("2024");
		expect(result).toContain("15");
	});
});

describe("getCurrentYearMonth", () => {
	it("returns the current year and 1-based month", () => {
		const now = new Date();
		const { year, month } = getCurrentYearMonth();
		expect(year).toBe(now.getFullYear());
		expect(month).toBe(now.getMonth() + 1);
		expect(month).toBeGreaterThanOrEqual(1);
		expect(month).toBeLessThanOrEqual(12);
	});
});

describe("formatBytes", () => {
	it("formats bytes with the requested decimals", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(1536, 2)).toBe("1.5 KB");
		expect(formatBytes(1024 ** 2)).toBe("1 MB");
	});

	it("handles invalid input", () => {
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});
});

describe("coerceDate", () => {
	it("passes Date instances through", () => {
		const d = new Date("2024-06-01T00:00:00.000Z");
		expect(coerceDate(d)).toEqual(d);
	});

	it("interprets numbers below 1e12 as seconds", () => {
		expect(coerceDate(1_700_000_000).getTime()).toBe(1_700_000_000_000);
	});

	it("interprets numbers at or above 1e12 as milliseconds", () => {
		expect(coerceDate(1_700_000_000_000).getTime()).toBe(1_700_000_000_000);
	});

	it("parses ISO strings", () => {
		expect(coerceDate("2024-06-01T00:00:00.000Z").toISOString()).toBe("2024-06-01T00:00:00.000Z");
	});

	it("falls back to the current date for unparseable input", () => {
		const before = Date.now();
		expect(coerceDate("garbage").getTime()).toBeGreaterThanOrEqual(before);
	});
});

describe("time utilities", () => {
	const nowMs = 1_700_000_000_000;

	it("timeBeforeHours returns seconds", () => {
		expect(timeBeforeHours(2, nowMs)).toBe(Math.floor((nowMs - 2 * 60 * 60 * 1000) / 1000));
	});

	it("timeBeforeHoursMs returns milliseconds", () => {
		expect(timeBeforeHoursMs(2, nowMs)).toBe(nowMs - 2 * 60 * 60 * 1000);
	});

	it("timeBeforeMinutes returns seconds", () => {
		expect(timeBeforeMinutes(30, nowMs)).toBe(Math.floor((nowMs - 30 * 60 * 1000) / 1000));
	});

	it("delay waits the requested duration", async () => {
		const start = Date.now();
		await delay(50);
		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});
});

describe("malformed tool call helpers", () => {
	const toolCall = '<invoke name="search">{}</invoke>';

	it("detects malformed tool calls", () => {
		expect(containsMalformedToolCall(toolCall)).toBe(true);
		expect(containsMalformedToolCall("just text")).toBe(false);
		expect(containsMalformedToolCall("")).toBe(false);
	});

	it("extracts tool call names", () => {
		const extracted = extractMalformedToolCalls(`text${toolCall}more`);
		expect(extracted).toHaveLength(1);
		expect(extracted[0]?.toolName).toBe("search");
	});

	it("strips malformed tool calls", () => {
		expect(stripMalformedToolCalls(`before ${toolCall} after`)).toBe("before  after");
	});

	it("filterToolCallText removes [TOOL_USE] / [TOOL_RESULT] markers", () => {
		const raw = `[TOOL_USE 1/1]\n{\n  "command": "ls"\n}\n[TOOL_RESULT 1/1]\nActual response`;
		const filtered = filterToolCallText(raw);
		expect(filtered).toContain("Actual response");
		expect(filtered).not.toContain("[TOOL_USE");
		expect(filtered).not.toContain("[TOOL_RESULT");
		expect(filtered).not.toContain("command");
	});
});

describe("buildNavigationUrl", () => {
	it("preserves pathname and query parameters", () => {
		const url = buildNavigationUrl({ pathname: "/chat/123", searchParams: "foo=bar" });
		expect(url).toBe("/chat/123?foo=bar");
	});

	it("updates query parameters", () => {
		const url = buildNavigationUrl({
			pathname: "/chat/123",
			searchParams: "foo=bar&baz=qux",
			paramsToUpdate: { baz: "updated", remove: null },
		});
		expect(url).toBe("/chat/123?foo=bar&baz=updated");
	});

	it("changes to the chat path when chatId is provided", () => {
		expect(buildNavigationUrl({ pathname: "/", chatId: "abc" })).toBe("/chat/abc");
		expect(buildNavigationUrl({ pathname: "/chat/old", chatId: null })).toBe("/");
	});
});

describe("user ID normalization", () => {
	it("strips the cloud_ prefix", () => {
		expect(normalizeUserId("cloud_abc-123")).toBe("abc-123");
		expect(normalizeUserId("abc-123")).toBe("abc-123");
	});

	it("compares normalized user IDs", () => {
		expect(userIdsEqual("cloud_abc", "abc")).toBe(true);
		expect(userIdsEqual("abc", "def")).toBe(false);
	});
});

describe("MemoCache", () => {
	it("stores and retrieves values", () => {
		const cache = new MemoCache<string>();
		cache.set("key", "value");
		expect(cache.get("key")).toBe("value");
	});

	it("returns undefined after TTL expiration", () => {
		vi.useFakeTimers();
		const cache = new MemoCache<string>();
		cache.set("key", "value", 1000);
		expect(cache.get("key")).toBe("value");

		vi.advanceTimersByTime(1001);
		expect(cache.get("key")).toBeUndefined();
		vi.useRealTimers();
	});

	it("refreshes TTL when ttlMs is provided on get (sliding expiration)", () => {
		vi.useFakeTimers();
		const cache = new MemoCache<string>();
		cache.set("key", "value", 1000);

		// Without ttlMs: read does not extend lifetime.
		vi.advanceTimersByTime(900);
		expect(cache.get("key")).toBe("value");

		// With ttlMs: extend expiresAt to now + 1000 (= 1900 from start).
		expect(cache.get("key", 1000)).toBe("value");

		// Past original 1000 but within refreshed window: still alive.
		vi.advanceTimersByTime(800); // wall time = 1700, expiresAt = 1900
		expect(cache.get("key")).toBe("value");

		// Beyond refreshed window: expired.
		vi.advanceTimersByTime(400); // wall time = 2100, expiresAt = 1900
		expect(cache.get("key")).toBeUndefined();
		vi.useRealTimers();
	});

	it("invalidates and clears entries", () => {
		const cache = new MemoCache<number>();
		cache.set("a", 1);
		cache.set("b", 2);
		cache.invalidate("a");
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);

		cache.clear();
		expect(cache.get("b")).toBeUndefined();
	});
});

describe("FileCache", () => {
	it("stores and retrieves values when mtime matches", () => {
		const cache = new FileCache<string>();
		cache.set("/path", 1000, "content");
		expect(cache.get("/path", 1000)).toBe("content");
	});

	it("invalidates when mtime changes", () => {
		const cache = new FileCache<string>();
		cache.set("/path", 1000, "content");
		expect(cache.get("/path", 1001)).toBeUndefined();
	});

	it("supports invalidate and clear", () => {
		const cache = new FileCache<string>();
		cache.set("/a", 1, "a");
		cache.invalidate("/a");
		expect(cache.get("/a", 1)).toBeUndefined();

		cache.set("/b", 2, "b");
		cache.clear();
		expect(cache.get("/b", 2)).toBeUndefined();
	});
});

describe("estimateTokens", () => {
	it("counts CJK characters one-for-one", () => {
		expect(estimateTokens("你好世界")).toBe(4);
	});

	it("estimates non-CJK characters at 5 per token", () => {
		expect(estimateTokens("hello world")).toBe(3); // 11 chars -> 3 tokens
	});

	it("handles mixed content", () => {
		expect(estimateTokens("hello 你好")).toBe(4); // 6 non-CJK -> 2 tokens + 2 CJK
	});
});

describe("inline reference helpers", () => {
	it("parses content with refs into segments", () => {
		const segments = parseContentWithRefs("Hello [[ref:people:Alice]] and [[ref:task:123]]");
		expect(segments).toEqual([
			{ type: "text", value: "Hello " },
			{ type: "ref", kind: "people", label: "Alice" },
			{ type: "text", value: " and " },
			{ type: "ref", kind: "task", label: "123" },
		]);
	});

	it("handles empty or non-string content", () => {
		expect(parseContentWithRefs("")).toEqual([{ type: "text", value: "" }]);
		expect(parseContentWithRefs(null)).toEqual([{ type: "text", value: "" }]);
	});

	it("finds the ref marker before the cursor", () => {
		expect(getRefMarkerRangeBeforeCursor("Hello [[ref:people:Alice]]", 27)).toEqual({ start: 7, end: 27 });
		expect(getRefMarkerRangeBeforeCursor("Hello", 5)).toBeNull();
		expect(getRefMarkerRangeBeforeCursor("Hello", 0)).toBeNull();
	});

	it("builds safe ref markers", () => {
		expect(buildRefMarker("people", "Alice")).toBe("[[ref:people:Alice]]");
		expect(buildRefMarker("task", "a]b")).toBe("[[ref:task:ab]]");
	});

	it("extracts refs by kind", () => {
		const content =
			"[[ref:people:Alice]] [[ref:channel:general:slack]] [[ref:event:e1|title]] [[ref:task:manual:1]]";
		const refs = extractRefsFromContent(content);
		expect(refs.people).toEqual([{ name: "Alice" }]);
		expect(refs.channels).toEqual([{ name: "general", platform: "slack" }]);
		expect(refs.eventIds).toEqual(["e1"]);
		expect(refs.taskIds).toEqual(["manual:1"]);
	});
});

describe("soul preset helpers", () => {
	it("getDefaultPrompt returns Chinese for zh locales", () => {
		expect(getDefaultPrompt("zh-CN")).toContain("你是 opencontext");
		expect(getDefaultPrompt("en-US")).toContain("You are opencontext");
	});

	it("getPresetPrompt returns bilingual prompts", () => {
		expect(getPresetPrompt("strategist", "zh-Hans")).toContain("战略家");
		expect(getPresetPrompt("strategist", "en-US")).toContain("Strategist");
		expect(getPresetPrompt("unknown", "en-US")).toBe("");
	});

	it("matches presets by prompt content", () => {
		const preset = getSoulPresetByPrompt(getPresetPrompt("executor", "en-US"));
		expect(preset?.id).toBe("executor");
	});

	it("getSelectedSoulPresetId defaults to default and detects custom", () => {
		expect(getSelectedSoulPresetId("")).toBe("default");
		expect(getSelectedSoulPresetId(getPresetPrompt("default", "en-US"))).toBe("default");
		expect(getSelectedSoulPresetId("custom prompt")).toBe("custom");
	});
});

describe("errors", () => {
	it("AppError parses error code and sets status", () => {
		const err = new AppError("not_found:chat");
		expect(err.type).toBe("not_found");
		expect(err.surface).toBe("chat");
		expect(err.statusCode).toBe(404);
		expect(err.message).toContain("chat was not found");
	});

	it("getMessageByErrorCode falls back to the cause or generic message", () => {
		expect(getMessageByErrorCode("bad_request:api", "invalid")).toContain("invalid");
		expect(getMessageByErrorCode("bad_request:bot", "cause text")).toBe("cause text");
		expect(getMessageByErrorCode("bad_request:bot")).toBe("Something went wrong. Please try again later.");
	});

	it("detects Telegram auth issues", () => {
		expect(isTelegramAuthIssue("400: AUTH_BYTES_INVALID")).toBe(true);
		expect(isTelegramAuthIssue("random")).toBe(false);
		expect(isTelegramAuthIssue(null)).toBe(false);
	});
});

describe("UserLocale", () => {
	it("collapses Chinese variants to zh-Hans", () => {
		expect(UserLocale.fromString("zh-TW")?.code).toBe("zh-Hans");
	});
});
