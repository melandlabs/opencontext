import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./markdown";

describe("markdownToTelegramHtml", () => {
	it("returns empty string for empty input", () => {
		expect(markdownToTelegramHtml("")).toBe("");
		expect(markdownToTelegramHtml("   ")).toBe("");
	});

	it("returns empty string for null/undefined input", () => {
		expect(markdownToTelegramHtml(null as unknown as string)).toBe("");
		expect(markdownToTelegramHtml(undefined as unknown as string)).toBe("");
	});

	it("converts bold markdown to <b> tags", () => {
		expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
		expect(markdownToTelegramHtml("__hello__")).toBe("<b>hello</b>");
	});

	it("converts italic markdown to <i> tags", () => {
		expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>");
		expect(markdownToTelegramHtml("_hello_")).toBe("<i>hello</i>");
	});

	it("converts strikethrough markdown to <s> tags", () => {
		expect(markdownToTelegramHtml("~~hello~~")).toBe("<s>hello</s>");
	});

	it("converts inline code to <code> tags", () => {
		expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
	});

	it("converts fenced code blocks to <pre><code>", () => {
		const input = "```js\nconst x = 1;\n```";
		expect(markdownToTelegramHtml(input)).toBe("<pre><code>const x = 1;\n</code></pre>");
	});

	it("converts links to anchor tags", () => {
		expect(markdownToTelegramHtml("[OpenContext](https://example.com)")).toBe(
			'<a href="https://example.com">OpenContext</a>',
		);
	});

	it("escapes HTML characters in plain text", () => {
		expect(markdownToTelegramHtml("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
	});

	it("escapes HTML characters inside link text", () => {
		expect(markdownToTelegramHtml("[a & b](https://example.com)")).toBe(
			'<a href="https://example.com">a &amp; b</a>',
		);
	});

	it("handles nested bold + italic", () => {
		expect(markdownToTelegramHtml("**bold *and italic***")).toBe("<b>bold <i>and italic</i></b>");
	});

	it("handles overlapping bold and link", () => {
		expect(markdownToTelegramHtml("**bold [link](https://x.com)**")).toBe(
			'<b>bold <a href="https://x.com">link</a></b>',
		);
	});

	it("renders unordered lists with bullet markers", () => {
		expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
	});

	it("renders ordered lists with numbers", () => {
		expect(markdownToTelegramHtml("1. one\n2. two")).toBe("1. one\n2. two");
	});

	it("renders tables as fixed-width code blocks", () => {
		const input = "| a | b |\n|---|---|\n| 1 | 2 |";
		const result = markdownToTelegramHtml(input);
		expect(result.startsWith("<pre><code>")).toBe(true);
		expect(result.endsWith("</code></pre>")).toBe(true);
		expect(result).toContain("| a | b |");
		expect(result).toContain("| 1 | 2 |");
	});

	it("renders blockquotes", () => {
		expect(markdownToTelegramHtml("> quote")).toBe("<blockquote>quote</blockquote>");
	});

	it("renders headings as plain text by default", () => {
		expect(markdownToTelegramHtml("# Heading")).toBe("Heading");
	});

	it("auto-linkifies bare URLs", () => {
		const result = markdownToTelegramHtml("Visit https://example.com today");
		expect(result).toContain('<a href="https://example.com">');
	});

	it("falls back to escaped plain text on parse error", () => {
		const badInput = "**unclosed";
		// Should not throw and should return escaped text.
		expect(() => markdownToTelegramHtml(badInput)).not.toThrow();
		expect(markdownToTelegramHtml(badInput)).toContain("unclosed");
	});
});
