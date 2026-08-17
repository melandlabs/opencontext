import { describe, expect, it } from "vitest";
import {
	buildSnippet,
	cleanEmailForLLM,
	cleanupMarkdown,
	htmlToPlainText,
	isBoilerplate,
	stripQuotedText,
} from "./email-content-cleaner.js";

describe("htmlToPlainText", () => {
	it("strips tags and decodes common entities", () => {
		const html = "<p>Hello &amp; welcome!</p><br/><div>Line &quot;one&quot; &lt;tag&gt;</div>";
		const plain = htmlToPlainText(html);
		expect(plain).toContain("Hello & welcome!");
		expect(plain).toContain('Line "one" <tag>');
		expect(plain).not.toContain("<p>");
		expect(plain).not.toContain("<br/>");
	});

	it("returns empty string for null/undefined", () => {
		expect(htmlToPlainText(null)).toBe("");
		expect(htmlToPlainText(undefined)).toBe("");
	});
});

describe("stripQuotedText", () => {
	it("removes lines starting with >", () => {
		const text = "Original reply\n> quoted line 1\n> quoted line 2\nFinal line";
		expect(stripQuotedText(text)).toBe("Original reply\nFinal line");
	});

	it("removes 'On ... wrote' markers followed by quoted content", () => {
		const text = "Thanks!\n\nOn Monday, User wrote:\n> quoted text\n> more quote";
		expect(stripQuotedText(text)).toBe("Thanks!");
	});

	it("removes 'From:' headers and stops at original message markers", () => {
		const text = "Reply\n\nFrom: someone@example.com\nSent: now\nTo: me\nSubject: Re";
		expect(stripQuotedText(text)).toBe("Reply");
	});

	it("returns empty string for empty input", () => {
		expect(stripQuotedText("")).toBe("");
	});
});

describe("isBoilerplate", () => {
	it("returns true for unsubscribe text", () => {
		expect(isBoilerplate("Unsubscribe")).toBe(true);
		expect(isBoilerplate("Click here to unsubscribe from our list")).toBe(true);
	});

	it("returns true for copyright text", () => {
		expect(isBoilerplate("Copyright © 2024 Acme Inc")).toBe(true);
		expect(isBoilerplate("All rights reserved.")).toBe(true);
	});

	it("returns true for short navigation bars with separators", () => {
		expect(isBoilerplate("Home | Products | Pricing | Blog")).toBe(true);
		expect(isBoilerplate("Shop · About · Contact")).toBe(true);
	});

	it("returns false for normal prose", () => {
		expect(isBoilerplate("Here is the quarterly report you requested.")).toBe(false);
		expect(isBoilerplate("We should schedule a meeting to discuss the proposal.")).toBe(false);
	});

	it("returns false for empty text", () => {
		expect(isBoilerplate("")).toBe(false);
	});
});

describe("cleanupMarkdown", () => {
	it("removes quote lines", () => {
		const md = "Hello\n> quoted\nWorld";
		expect(cleanupMarkdown(md)).toBe("Hello\nWorld");
	});

	it("removes unsubscribe and view-in-browser lines", () => {
		const md = "Hello\nUnsubscribe here\nView in browser\nprivacy policy\nWorld";
		expect(cleanupMarkdown(md)).toBe("Hello\nWorld");
	});

	it("removes horizontal rule lines", () => {
		const md = "Hello\n--\nWorld";
		expect(cleanupMarkdown(md)).toBe("Hello\nWorld");
	});
});

describe("buildSnippet", () => {
	it("leaves short text unchanged", () => {
		const text = "Short message.";
		expect(buildSnippet(text)).toBe("Short message.");
	});

	it("truncates long text with ellipsis", () => {
		const text = "a".repeat(300);
		const snippet = buildSnippet(text);
		expect(snippet).toHaveLength(240);
		expect(snippet.endsWith("...")).toBe(true);
	});

	it("uses custom max length", () => {
		const text = "hello world this is a test";
		expect(buildSnippet(text, 10)).toBe("hello w...");
	});
});

describe("cleanEmailForLLM", () => {
	it("returns markdown, plain, and cleanHtml for HTML input", () => {
		const html =
			"<html><body><p>Hello <b>world</b></p><p>Click <a href='https://example.com'>here</a> to unsubscribe.</p></body></html>";
		const result = cleanEmailForLLM({ html });
		expect(result.markdown).toBeTruthy();
		expect(result.plain).toBeTruthy();
		expect(result.cleanHtml).toBeTruthy();
		expect(result.plain).toContain("Hello world");
		expect(result.markdown).toContain("Hello **world**");
	});

	it("returns markdown and plain for plain text input", () => {
		const text = "Hello world\n\n> quoted text";
		const result = cleanEmailForLLM({ text });
		expect(result.markdown).toBeTruthy();
		expect(result.plain).toContain("Hello world");
		expect(result.markdown).not.toContain("> quoted text");
	});

	it("returns empty results for empty input", () => {
		const result = cleanEmailForLLM({});
		expect(result.markdown).toBe("");
		expect(result.plain).toBe("");
		expect(result.cleanHtml).toBeUndefined();
	});
});
