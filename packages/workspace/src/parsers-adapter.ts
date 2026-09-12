/**
 * `@melandlabs/workspace` — multi-format text extractor.
 *
 * Supported inputs:
 *   - `.md` / `.markdown`       — pass-through (front-matter is parsed by
 *                                 `okf-backend` separately)
 *   - `.txt`                   — pass-through
 *   - `.pdf`                   — `parseFileToDocument` (`@melandlabs/rag`)
 *   - `.docx`                  — `parseFileToDocument`
 *   - `.pages`                 — `parseFileToDocument` (via `AppleDocumentLoader`)
 *   - `.xlsx` / `.xls`         — SheetJS (`xlsx`) — round-trips every sheet to
 *                                 CSV. `@langchain/community` does not ship an
 *                                 Excel loader, so we go straight to SheetJS
 *                                 instead of paying the langchain dependency
 *                                 tax.
 *   - `.numbers`               — `textutil -convert xlsx` (macOS only),
 *                                 then the `.xlsx` path above.
 *
 * Binary raster files (`.png`, `.jpg`, …) intentionally raise an explicit
 * "unsupported" error so the caller can fall back to manual transcription.
 */

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname } from "node:path";
import { promisify } from "node:util";
import { parseFile, parseFileToDocument } from "@melandlabs/rag";
import { estimateTokens } from "@melandlabs/shared";

const execFileAsync = promisify(execFile);

let _parsersConfigured = false;

function ensureParsersConfigured(): void {
	if (_parsersConfigured) return;
	// `parseFile` only uses `estimateTokens` for chunk-count estimation,
	// which we don't currently invoke; provide a stub anyway so future
	// callers that hit `estimateChunkCount` don't crash.
	try {
		const { configureParsers } = require("@melandlabs/rag") as {
			configureParsers?: (config: { estimateTokens: (text: string) => number }) => void;
		};
		configureParsers?.({ estimateTokens });
	} catch {
		// No-op: some builds don't expose `configureParsers` directly.
	}
	_parsersConfigured = true;
}

export interface ExtractedText {
	text: string;
	mimeType: string;
	metadata?: Record<string, unknown>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	".md": "text/markdown",
	".markdown": "text/markdown",
	".txt": "text/plain",
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".doc": "application/msword",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
	".pages": "application/x-iwork-pages-sffpages",
	".numbers": "application/x-iwork-numbers-sffnumbers",
	".keynote": "application/x-iwork-keynote-sffkeynote",
	".html": "text/html",
	".htm": "text/html",
};

/**
 * Best-effort MIME guess from the file extension. Falls back to
 * `application/octet-stream` so `parseFile` throws a clear "unsupported
 * content type" error rather than silently producing garbage.
 */
export function detectMimeType(sourcePath: string): string {
	const ext = extname(sourcePath).toLowerCase();
	return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Render a SheetJS workbook buffer as one CSV block per sheet. Used for
 * `.xlsx` / `.xls` (and `.numbers` after a one-shot `textutil` conversion).
 *
 * Sheets are separated by `\n\n# Sheet: <name>\n` so the chunker can
 * preserve sheet boundaries without any extra metadata plumbing.
 */
async function extractSpreadsheet(
	buffer: Buffer,
	mimeType: string,
	sourcePath: string,
): Promise<ExtractedText> {
	const xlsxModule = await import("xlsx");
	// SheetJS exposes its surface as a namespace; some build entries also
	// re-export it under `.default`. Coalesce both shapes here so we don't
	// care which one `pnpm install` resolved at runtime.
	const XLSX = ((xlsxModule as unknown as { default?: typeof xlsxModule }).default ??
		xlsxModule) as typeof xlsxModule;
	type SheetJSModule = typeof import("xlsx");
	type Workbook = ReturnType<SheetJSModule["read"]>;
	const workbook = XLSX.read(buffer, { type: "buffer" }) as Workbook;
	const blocks: string[] = [];
	const sheetNames = workbook.SheetNames as string[];
	for (const name of sheetNames) {
		const sheet = workbook.Sheets[name];
		if (!sheet) continue;
		const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
		if (!csv.trim()) continue;
		blocks.push(`# Sheet: ${name}\n${csv.replace(/\n+$/, "")}`);
	}
	return {
		text: blocks.join("\n\n"),
		mimeType,
		metadata: {
			source: sourcePath,
			sheets: sheetNames,
			sheet_count: sheetNames.length,
		},
	};
}

/**
 * Convert an Apple Numbers workbook to .xlsx via the bundled
 * `textutil` (macOS only). Returns the converted file path or null
 * if the host is not macOS or `textutil` is missing.
 */
async function convertNumbersToXlsx(sourcePath: string): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	const outDir = tmpdir();
	try {
		await execFileAsync("textutil", ["-convert", "xlsx", "-output", outDir, sourcePath]);
		return `${outDir}/${
			sourcePath
				.split("/")
				.pop()
				?.replace(/\.numbers$/, ".xlsx") ?? "fixture.xlsx"
		}`;
	} catch {
		return null;
	}
}

/**
 * Read the source file, dispatch to the appropriate loader, and return
 * the canonical text body used by both the chunker and the embedder.
 */
export async function extractText(sourcePath: string, mimeType?: string): Promise<ExtractedText> {
	ensureParsersConfigured();
	const ext = extname(sourcePath).toLowerCase();
	const mime = mimeType ?? detectMimeType(sourcePath);
	if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
		const text = await readFile(sourcePath, "utf8");
		return { text, mimeType: mime };
	}
	const buffer = await readFile(sourcePath);
	// Spreadsheets: SheetJS handles .xlsx / .xls directly. .numbers
	// gets a one-shot textutil conversion on macOS, then falls through
	// to the SheetJS path. Other platforms reject .numbers explicitly.
	if (ext === ".xlsx" || ext === ".xls") {
		return extractSpreadsheet(buffer, mime, sourcePath);
	}
	if (ext === ".numbers") {
		const converted = await convertNumbersToXlsx(sourcePath);
		if (!converted) {
			throw new Error(
				`.numbers parsing requires macOS (textutil); not available on ${process.platform}. Convert the file to .xlsx first.`,
			);
		}
		try {
			const xlsxBuffer = await readFile(converted);
			return extractSpreadsheet(xlsxBuffer, MIME_BY_EXTENSION[".xlsx"], sourcePath);
		} finally {
			unlink(converted).catch(() => undefined);
		}
	}
	// The RAG layer exposes `parseFile` (returns `{text, metadata}`) and
	// `parseFileToDocument` (returns a LangChain `Document`). The latter
	// also surfaces page-level metadata; prefer it when callers can
	// surface metadata downstream.
	const document = await parseFileToDocument(buffer, mime, sourcePath);
	return {
		text: document.pageContent,
		mimeType: mime,
		metadata: document.metadata as Record<string, unknown>,
	};
}

/**
 * Convenience re-export of `parseFile` so the OKF backend can opt into
 * the lighter (no-LangChain-Document) path when it only needs text.
 */
export async function extractTextRaw(sourcePath: string, mimeType?: string): Promise<ExtractedText> {
	ensureParsersConfigured();
	const ext = extname(sourcePath).toLowerCase();
	const mime = mimeType ?? detectMimeType(sourcePath);
	if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
		const text = await readFile(sourcePath, "utf8");
		return { text, mimeType: mime };
	}
	if (ext === ".xlsx" || ext === ".xls") {
		const buffer = await readFile(sourcePath);
		return extractSpreadsheet(buffer, mime, sourcePath);
	}
	if (ext === ".numbers") {
		const converted = await convertNumbersToXlsx(sourcePath);
		if (!converted) {
			throw new Error(`.numbers parsing requires macOS (textutil); not available on ${process.platform}.`);
		}
		try {
			const xlsxBuffer = await readFile(converted);
			return extractSpreadsheet(xlsxBuffer, MIME_BY_EXTENSION[".xlsx"], sourcePath);
		} finally {
			unlink(converted).catch(() => undefined);
		}
	}
	const buffer = await readFile(sourcePath);
	const { text, metadata } = await parseFile(buffer, mime);
	return { text, mimeType: mime, metadata };
}
