import { describe, expect, it } from "vitest";
import { markdownToWhatsApp } from "./markdown";

describe("markdownToWhatsApp", () => {
	it("returns empty string for empty input", () => {
		expect(markdownToWhatsApp("")).toBe("");
	});

	it("returns null/undefined as-is", () => {
		expect(markdownToWhatsApp(null as unknown as string)).toBeNull();
		expect(markdownToWhatsApp(undefined as unknown as string)).toBeUndefined();
	});

	it("converts **bold** to *bold*", () => {
		expect(markdownToWhatsApp("**hello**")).toBe("*hello*");
	});

	it("converts __bold__ to *bold*", () => {
		expect(markdownToWhatsApp("__hello__")).toBe("*hello*");
	});

	it("converts ~~strikethrough~~ to ~strikethrough~", () => {
		expect(markdownToWhatsApp("~~hello~~")).toBe("~hello~");
	});

	it("leaves single-asterisk italic unchanged", () => {
		// WhatsApp uses _text_ for italic, and single * for bold.
		// The converter leaves single markers alone.
		expect(markdownToWhatsApp("*hello*")).toBe("*hello*");
	});

	it("leaves underscore italic unchanged", () => {
		expect(markdownToWhatsApp("_hello_")).toBe("_hello_");
	});

	it("protects inline code from conversion", () => {
		expect(markdownToWhatsApp("`**bold**`")).toBe("`**bold**`");
		expect(markdownToWhatsApp("`~~strike~~`")).toBe("`~~strike~~`");
	});

	it("protects fenced code blocks from conversion", () => {
		const input = "```\n**bold**\n~~strike~~\n```";
		expect(markdownToWhatsApp(input)).toBe(input);
	});

	it("handles mixed formatting outside code", () => {
		const input = "**bold** and ~~strike~~ and `_code_`";
		expect(markdownToWhatsApp(input)).toBe("*bold* and ~strike~ and `_code_`");
	});

	it("converts multiple bold segments", () => {
		expect(markdownToWhatsApp("**a** b **c**")).toBe("*a* b *c*");
	});

	it("converts nested bold inside a sentence", () => {
		expect(markdownToWhatsApp("This is **very** important")).toBe("This is *very* important");
	});

	it("does not convert markers inside inline code even between other text", () => {
		expect(markdownToWhatsApp("Use `**not bold**` here")).toBe("Use `**not bold**` here");
	});

	it("preserves plain text without formatting", () => {
		expect(markdownToWhatsApp("hello world")).toBe("hello world");
	});

	it("handles text with only whitespace", () => {
		expect(markdownToWhatsApp("   ")).toBe("   ");
	});
});
