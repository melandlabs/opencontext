import type { IntegrationId } from "@melandlabs/contracts/integration-id";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatConnectorAuthError,
	formatConnectorConnectionError,
	getConnectableIntegrationPlatforms,
	getConnectorNetworkAuthErrorMessage,
	getPlatformConnectCardTheme,
	getPlatformDisplayInfo,
	inferTaskIntegrationRequirementsFromText,
	isConnectorAuthNetworkError,
	isIntegrationPlatformConnectable,
	isIntegrationPlatformVisible,
	jsonForScript,
	resolvePlatformLogo,
} from "./index";

describe("platform visuals", () => {
	it("resolves logos for known platforms and null for unknown ones", () => {
		expect(resolvePlatformLogo("slack")).toBe("/images/apps/slack.png");
		expect(resolvePlatformLogo("telegram")).toBe("/images/apps/telegram.png");
		expect(resolvePlatformLogo("unknown_platform" as IntegrationId)).toBeNull();
	});

	it("returns display info for known platforms", () => {
		const slack = getPlatformDisplayInfo("slack");
		expect(slack.label).toBe("Slack");
		expect(slack.icon).toBe("slack");
		expect(slack.iconBackground).toContain("#4A154B");
	});

	it("falls back for unknown platforms", () => {
		const info = getPlatformDisplayInfo("unknown_platform" as IntegrationId);
		expect(info.label).toBe("Unknown_platform");
		expect(info.icon).toBe("ticket");
		expect(info.iconBackground).toContain("gray-500");
	});

	it("localizes the Weixin label when a t function is provided", () => {
		const t = (key: string) => (key === "platform.weixin" ? "WeChat" : undefined);
		expect(getPlatformDisplayInfo("weixin", t as any).label).toBe("WeChat");
		expect(getPlatformDisplayInfo("weixin").label).toBe("Weixin");
	});

	it("returns connect card themes for known platforms and a default otherwise", () => {
		const slack = getPlatformConnectCardTheme("slack");
		expect(slack.buttonBackground).toBe("#4A154B");

		const fallback = getPlatformConnectCardTheme("unknown_platform" as IntegrationId);
		expect(fallback.buttonBackground).toBe("#000000");
	});
});

describe("platform connectability", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("hides internal-only platforms", () => {
		expect(isIntegrationPlatformConnectable("google_meet")).toBe(false);
	});

	it("marks coming-soon platforms as not connectable", () => {
		expect(isIntegrationPlatformConnectable("github")).toBe(false);
		expect(isIntegrationPlatformConnectable("instagram")).toBe(false);
		expect(isIntegrationPlatformConnectable("asana")).toBe(false);
	});

	it("gates outlook calendar behind an environment variable", () => {
		vi.stubEnv("NEXT_PUBLIC_OUTLOOK_CALENDAR_ENABLED", "true");
		expect(isIntegrationPlatformConnectable("outlook_calendar")).toBe(true);

		vi.stubEnv("NEXT_PUBLIC_OUTLOOK_CALENDAR_ENABLED", "false");
		expect(isIntegrationPlatformConnectable("outlook_calendar")).toBe(false);

		vi.unstubAllEnvs();
		expect(isIntegrationPlatformConnectable("outlook_calendar")).toBe(false);
	});

	it("treats other platforms as connectable", () => {
		expect(isIntegrationPlatformConnectable("slack")).toBe(true);
		expect(isIntegrationPlatformConnectable("telegram")).toBe(true);
		expect(isIntegrationPlatformConnectable("gmail")).toBe(true);
	});

	it("lists only connectable platforms", () => {
		const connectable = getConnectableIntegrationPlatforms();
		expect(connectable).toContain("slack");
		expect(connectable).toContain("telegram");
		expect(connectable).not.toContain("google_meet");
		expect(connectable).not.toContain("github");
	});
});

describe("platform visibility", () => {
	it("never shows hidden platforms", () => {
		expect(isIntegrationPlatformVisible("google_meet")).toBe(false);
		expect(isIntegrationPlatformVisible("google_meet", { hasConnectedAccounts: true })).toBe(false);
	});

	it("shows connectable platforms", () => {
		expect(isIntegrationPlatformVisible("slack")).toBe(true);
		expect(isIntegrationPlatformVisible("gmail")).toBe(true);
	});

	it("shows non-connectable platforms only when they have connected accounts", () => {
		expect(isIntegrationPlatformVisible("github")).toBe(false);
		expect(isIntegrationPlatformVisible("github", { hasConnectedAccounts: true })).toBe(true);
	});
});

describe("task integration inference", () => {
	it("returns empty requirements for empty text", () => {
		expect(inferTaskIntegrationRequirementsFromText("")).toEqual({
			sources: [],
			notificationChannels: [],
		});
		expect(inferTaskIntegrationRequirementsFromText("   ")).toEqual({
			sources: [],
			notificationChannels: [],
		});
	});

	it("infers Gmail as a source from pull intents", () => {
		const result = inferTaskIntegrationRequirementsFromText("从 Gmail 拉取邮件");
		expect(result.sources).toEqual([{ type: "channel", name: "gmail:__required__::Gmail" }]);
		expect(result.notificationChannels).toEqual([]);
	});

	it("infers Gmail as a notification channel from send intents", () => {
		const result = inferTaskIntegrationRequirementsFromText("通过 Gmail 发送报告");
		expect(result.sources).toEqual([]);
		expect(result.notificationChannels).toEqual(["gmail:__required__"]);
	});

	it("infers Slack as a source from read intents", () => {
		const result = inferTaskIntegrationRequirementsFromText("从 Slack 读取消息");
		expect(result.sources).toEqual([{ type: "channel", name: "slack:__required__::Slack" }]);
		expect(result.notificationChannels).toEqual([]);
	});

	it("infers Slack as a notification channel from send intents", () => {
		const result = inferTaskIntegrationRequirementsFromText("send me a Slack notification");
		expect(result.sources).toEqual([]);
		expect(result.notificationChannels).toEqual(["slack:__required__"]);
	});

	it("infers Twitter as a source from Chinese pull intents", () => {
		const result = inferTaskIntegrationRequirementsFromText("从 Twitter 拉取推文");
		expect(result.sources).toEqual([{ type: "channel", name: "twitter:__required__::X/Twitter" }]);
	});
});

describe("connector auth error formatting", () => {
	it("produces a human-readable network error message", () => {
		expect(getConnectorNetworkAuthErrorMessage("telegram")).toBe(
			"Unable to connect to Telegram. Please check your network connection and try again.",
		);
		expect(getConnectorNetworkAuthErrorMessage("whatsapp")).toBe(
			"Unable to connect to WhatsApp. Please check your network connection and try again.",
		);
	});

	it("detects network-related errors", () => {
		expect(isConnectorAuthNetworkError(new Error("fetch failed"))).toBe(true);
		expect(isConnectorAuthNetworkError("ETIMEDOUT connecting to telegram")).toBe(true);
		expect(isConnectorAuthNetworkError("socket connection timed out")).toBe(true);
		expect(isConnectorAuthNetworkError("[whatsapp] socket failed to connect within 30000ms")).toBe(true);
	});

	it("does not treat user-action timeouts as network errors", () => {
		expect(isConnectorAuthNetworkError("password input timed out")).toBe(false);
		expect(isConnectorAuthNetworkError("verification code timed out")).toBe(false);
		expect(isConnectorAuthNetworkError("qr login timed out")).toBe(false);
	});

	it("ignores empty values", () => {
		expect(isConnectorAuthNetworkError("")).toBe(false);
		expect(isConnectorAuthNetworkError(null)).toBe(false);
		expect(isConnectorAuthNetworkError(undefined)).toBe(false);
	});

	it("formats auth errors using the network message when appropriate", () => {
		expect(formatConnectorAuthError("fetch failed", "telegram")).toBe(
			getConnectorNetworkAuthErrorMessage("telegram"),
		);
	});

	it("formats auth errors by preserving their message otherwise", () => {
		expect(formatConnectorAuthError("invalid password", "telegram")).toBe("invalid password");
		expect(formatConnectorAuthError("", "telegram", "custom fallback")).toBe("custom fallback");
	});

	it("formats connection errors using the network message when appropriate", () => {
		expect(formatConnectorConnectionError("ECONNREFUSED", "whatsapp")).toBe(
			getConnectorNetworkAuthErrorMessage("whatsapp"),
		);
	});

	it("falls back to a platform-specific message for connection errors", () => {
		expect(formatConnectorConnectionError("something else", "whatsapp")).toBe(
			"Failed to connect to WhatsApp servers",
		);
		expect(formatConnectorConnectionError("", "telegram", "fallback")).toBe("fallback");
	});
});

describe("jsonForScript", () => {
	it("escapes opening angle brackets for safe script embedding", () => {
		expect(jsonForScript("</script>")).toBe('"\\u003c/script>"');
	});

	it("leaves other characters unchanged", () => {
		expect(jsonForScript({ foo: "bar>baz" })).toBe('{"foo":"bar>baz"}');
	});

	it("passes undefined through", () => {
		expect(jsonForScript(undefined)).toBeUndefined();
	});
});
