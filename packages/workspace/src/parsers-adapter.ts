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
 *
 * Binary raster files (`.png`, `.jpg`, …) intentionally raise an explicit
 * "unsupported" error so the caller can fall back to manual transcription.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseFile, parseFileToDocument } from "@melandlabs/rag";
import { estimateTokens } from "@melandlabs/shared";

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
	const buffer = await readFile(sourcePath);
	const { text, metadata } = await parseFile(buffer, mime);
	return { text, mimeType: mime, metadata };
}
