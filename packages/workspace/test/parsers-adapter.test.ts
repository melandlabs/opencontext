/**
 * Tests for `parsers-adapter.extractText`. Validates the text-extraction
 * path for plain `.md` / `.txt` files (which should be a UTF-8 pass-through)
 * and that the MIME detection is stable across file extensions.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectMimeType, extractText, stripHtmlTags } from "../src/parsers-adapter";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "workspace-parsers-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("parsers-adapter", () => {
	it("detects MIME types by extension", () => {
		expect(detectMimeType("a.md")).toBe("text/markdown");
		expect(detectMimeType("a.markdown")).toBe("text/markdown");
		expect(detectMimeType("a.txt")).toBe("text/plain");
		expect(detectMimeType("a.pdf")).toBe("application/pdf");
		expect(detectMimeType("a.docx")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(detectMimeType("a.pages")).toBe("application/x-iwork-pages-sffpages");
		expect(detectMimeType("a.html")).toBe("text/html");
		expect(detectMimeType("a.htm")).toBe("text/html");
		expect(detectMimeType("a.csv")).toBe("text/csv");
		expect(detectMimeType("a.unknown")).toBe("application/octet-stream");
	});

	it("extracts text from a plain markdown file", async () => {
		const filePath = join(scratchDir, "note.md");
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(filePath, "# Title\n\nThis is the body.", "utf8");
		const result = await extractText(filePath);
		expect(result.text).toContain("# Title");
		expect(result.text).toContain("This is the body.");
		expect(result.mimeType).toBe("text/markdown");
	});

	it("extracts text from a plain text file", async () => {
		const filePath = join(scratchDir, "notes.txt");
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(filePath, "first line\nsecond line\n", "utf8");
		const result = await extractText(filePath);
		expect(result.text).toBe("first line\nsecond line\n");
		expect(result.mimeType).toBe("text/plain");
	});

	it("strips HTML tags, scripts, styles, comments, and common entities", () => {
		const html = `<!doctype html>
<html><head><title>Smoke</title></head>
<body>
<script>alert('x')</script>
<style>p { color: red; }</style>
<h1>Hello & goodbye</h1>
<p>Paragraph with <em>emphasis</em> and a&nbsp;space.</p>
<!-- internal comment -->
</body></html>`;
		const stripped = stripHtmlTags(html);
		expect(stripped).not.toMatch(/<[^>]+>/);
		expect(stripped).not.toContain("alert(");
		expect(stripped).not.toContain("color: red");
		expect(stripped).not.toContain("internal comment");
		expect(stripped).toContain("Hello");
		expect(stripped).toContain("goodbye");
		expect(stripped).toContain("emphasis");
		expect(stripped).toContain("Paragraph");
	});

	it("extracts text from an HTML file via tag-strip", async () => {
		const filePath = join(scratchDir, "page.html");
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(
			filePath,
			`<html><body><h1>服务条款</h1><p>第一段正文。</p></body></html>`,
			"utf8",
		);
		const result = await extractText(filePath);
		expect(result.mimeType).toBe("text/html");
		expect(result.text).toContain("服务条款");
		expect(result.text).toContain("第一段正文");
		expect(result.text).not.toMatch(/<[^>]+>/);
	});
});
