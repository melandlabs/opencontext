/**
 * Knowledge Package reader / writer.
 *
 * A Knowledge Package is a directory of `.md` files plus an optional
 * `manifest.json` that summarises the contents. The directory is
 * laid out as:
 *
 *   <root>/
 *     manifest.json            (optional on read, always written on emit)
 *     <Type>/<slug>.md         (one file per fact)
 *     ...
 *
 * The Type folder prefix is the OKF `type` field (e.g. `Reference`,
 * `Experience`, `Opinion`). Slug-ified resource id is the file name.
 *
 * Read tolerates:
 *   - missing `manifest.json` (counts are inferred)
 *   - nested directories (recursive scan)
 *   - ignore everything that isn't `.md`
 *
 * Write is non-destructive by default (fails on collision unless
 * `overwrite: true`).
 */

import type { Stats } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import {
	type OkfDocument,
	type OkfFrontMatter,
	type OkfPackageManifest,
	OkfPackageManifestSchema,
} from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import { rawMessageToOkf } from "./codec.js";
import { OkfError, type OkfIssue } from "./errors.js";
import { parseOkf, stringifyOkf, validateOkfFrontMatter } from "./frontmatter.js";

export interface ReadOkfPackageOptions {
	/** Glob of files to include. Default: `**\/*.md`. */
	glob?: string;
	/** If true, recurse into subdirectories. Default: true. */
	recursive?: boolean;
}

export interface OkfPackageFile {
	/** Path relative to the package root (always forward-slash, no leading `./`). */
	path: string;
	document: OkfDocument;
	issues: OkfIssue[];
	/** File mtime in ms, captured alongside the read. Used as a fallback `generated.at`. */
	mtimeMs?: number;
}

export interface ReadOkfPackageResult {
	/** Optional manifest parsed from `<root>/manifest.json`. */
	manifest?: OkfPackageManifest;
	/**
	 * Issues surfaced while reading `manifest.json` (invalid JSON,
	 * schema drift). Empty when the manifest is absent or parsed cleanly.
	 * The CLI/HTTP surface bubbles these into the `issues[]` envelope
	 * so callers can distinguish a manifest failure from per-file ones.
	 */
	manifestIssues: OkfIssue[];
	files: OkfPackageFile[];
}

/**
 * Read a Knowledge Package from disk. Returns the parsed documents +
 * per-file `OkfIssue`s (missing-required warnings, NOT throws).
 */
export async function readOkfPackage(
	root: string,
	options: ReadOkfPackageOptions = {},
): Promise<ReadOkfPackageResult> {
	const recursive = options.recursive ?? true;
	const files: OkfPackageFile[] = [];
	const manifestIssues: OkfIssue[] = [];
	let manifest: OkfPackageManifest | undefined;

	try {
		const result = await tryReadManifest(root);
		manifest = result.manifest;
		manifestIssues.push(...result.issues);
	} catch (err) {
		if (!(err instanceof OkfError)) throw err;
		// Don't fail the whole read on a malformed manifest — the
		// per-file validation will still surface the problem. Surface the
		// error as a manifest issue so the CLI/HTTP envelopes carry it.
		manifestIssues.push(...err.issues, {
			code: err.code,
			message: err.message,
		});
	}

	await walk(root, root, recursive, async (filePath, relPath) => {
		if (extname(filePath).toLowerCase() !== ".md") return;
		const [text, mtimeMs] = await Promise.all([readFile(filePath, "utf8"), safeMtime(filePath)]);
		let frontMatter: OkfFrontMatter;
		let body: string;
		try {
			const parsed = parseOkf(text);
			frontMatter = parsed.frontMatter;
			body = parsed.body;
		} catch (err) {
			// Surface the parse error as a single issue per file so the
			// caller can decide whether to fail.
			const message = err instanceof Error ? err.message : String(err);
			files.push({
				path: relPath,
				document: { frontMatter: {}, body: text },
				issues: [{ code: "invalid_yaml", message, file: relPath }],
				mtimeMs,
			});
			return;
		}
		const issues = validateOkfFrontMatter(frontMatter).map((issue) => ({
			...issue,
			file: relPath,
		}));
		const document: OkfDocument = {
			frontMatter,
			body,
			...(frontMatterResource(frontMatter) ? { resource: frontMatterResource(frontMatter) } : {}),
		};
		files.push({ path: relPath, document, issues, mtimeMs });
	});

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { manifest, manifestIssues, files };
}

/** Best-effort file mtime capture — returns undefined on stat failure so reads still succeed. */
async function safeMtime(filePath: string): Promise<number | undefined> {
	try {
		const s = await stat(filePath);
		return s.mtimeMs;
	} catch {
		return undefined;
	}
}

async function readManifest(root: string): Promise<OkfPackageManifest> {
	const text = await readFile(join(root, "manifest.json"), "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new OkfError(`manifest.json is not valid JSON: ${(err as Error).message}`, {
			code: "schema_mismatch",
		});
	}
	const result = OkfPackageManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new OkfError("manifest.json does not match the okf/v0.2 schema", {
			code: "schema_mismatch",
			issues: result.error.issues.map((i) => ({
				code: "schema_mismatch" as const,
				message: i.message,
				field: i.path.join("."),
			})),
		});
	}
	return result.data;
}

async function tryReadManifest(root: string): Promise<{ manifest?: OkfPackageManifest; issues: OkfIssue[] }> {
	const manifestPath = join(root, "manifest.json");
	try {
		await stat(manifestPath);
	} catch {
		// Missing manifest is fine — we just won't have counts.
		return { issues: [] };
	}
	try {
		const manifest = await readManifest(root);
		return { manifest, issues: [] };
	} catch (err) {
		// Surface the parse / schema failure on the result envelope
		// instead of throwing. `readManifest` throws OkfError with a
		// structured `issues[]` payload so we propagate it verbatim.
		if (err instanceof OkfError) {
			return { issues: err.issues.length > 0 ? err.issues : [{ code: err.code, message: err.message }] };
		}
		return {
			issues: [{ code: "schema_mismatch", message: err instanceof Error ? err.message : String(err) }],
		};
	}
}

function frontMatterResource(fm: OkfFrontMatter): string | undefined {
	// Fall back to the OKF `resource` field if the emitter added one.
	return (fm as Record<string, unknown>).resource as string | undefined;
}

// ─── Emit ─────────────────────────────────────────────────────────────

export interface WriteOkfPackageOptions {
	/** User ids to include in the manifest. Default: inferred from the messages. */
	userIds?: string[];
	/** Platforms to include in the manifest. Default: inferred from the messages. */
	platforms?: string[];
	/** Manifest name override. */
	packageName?: string;
	/** Manifest generation timestamp (ms). Default: `Date.now()`. */
	generatedAtMs?: number;
	/** Package version used as the `generated.by` fallback. */
	packageVersion?: string;
	/** Overwrite existing files. Default: false. */
	overwrite?: boolean;
	/** When true, include archived (deprecated) messages. Default: false. */
	includeArchived?: boolean;
}

export interface WriteOkfPackageResult {
	manifest: OkfPackageManifest;
	written: number;
	skipped: number;
	paths: string[];
}

/**
 * Emit a Knowledge Package (directory of `.md` files + `manifest.json`)
 * from a list of `RawMessage`s. The directory layout is:
 *
 *   <root>/
 *     manifest.json
 *     <Type>/<slug>.md
 *
 * Slug collisions are resolved by appending `-2`, `-3`, … before
 * writing. The first source URL goes into `attachments[0].url`; the
 * front-matter `sources[]` array always carries every source.
 */
export async function writeOkfPackage(
	root: string,
	messages: RawMessage[],
	options: WriteOkfPackageOptions = {},
): Promise<WriteOkfPackageResult> {
	const overwrite = options.overwrite ?? false;
	const includeArchived = options.includeArchived ?? false;
	const generatedAtMs = options.generatedAtMs ?? Date.now();
	const nowIso = new Date(generatedAtMs).toISOString();

	await mkdir(root, { recursive: true });

	const seen = new Set<string>();
	const userIds = new Set<string>(options.userIds ?? []);
	const platforms = new Set<string>(options.platforms ?? []);
	const sources = new Set<string>(["memory-store"]);
	const typeCounts: Record<string, number> = {};
	const paths: string[] = [];
	let written = 0;
	let skipped = 0;

	const messagesToEmit = includeArchived ? messages : messages.filter((m) => m.archivedAt === undefined);

	for (const raw of messagesToEmit) {
		const { document, body } = rawMessageToOkf(raw, { packageVersion: options.packageVersion });
		const type = document.frontMatter.type ?? "Reference";
		// Sanitise the type into a traversal-safe folder name so a crafted
		// `metadata.okfType` (e.g. "../../../tmp/evil") can't escape `root`.
		// We keep the original casing (the on-disk layout uses `Reference`,
		// `Experience`, …) and only strip path separators / leading dots.
		const safeType = sanitizeTypeFolder(type);
		const slug = dedupSlug(raw.messageId, seen);
		const filePath = join(root, safeType, `${slug}.md`);

		try {
			await stat(filePath);
			if (!overwrite) {
				skipped += 1;
				continue;
			}
		} catch {
			// File doesn't exist — perfect.
		}

		await mkdir(dirname(filePath), { recursive: true });
		const text = stringifyOkf({ frontMatter: document.frontMatter, body });
		await writeFile(filePath, text, "utf8");
		written += 1;
		seen.add(slug);
		paths.push(relative(root, filePath).split(sep).join("/"));
		typeCounts[safeType] = (typeCounts[safeType] ?? 0) + 1;
		if (raw.userId) userIds.add(raw.userId);
		if (raw.platform) platforms.add(raw.platform);
	}

	const manifest: OkfPackageManifest = {
		schema: "okf/v0.2",
		name:
			options.packageName ??
			`opencontext-export-${[...userIds].sort().join(",") || "unknown"}-${formatYmd(generatedAtMs)}`,
		generatedAt: nowIso,
		generatedBy: `opencontext@${options.packageVersion ?? "0.0.0"}`,
		okfConceptCount: written,
		okfTypeCounts: typeCounts,
		sources: [...sources].sort(),
		userIds: [...userIds].sort(),
		platforms: [...platforms].sort(),
		files: paths.sort(),
	};

	await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

	return { manifest, written, skipped, paths };
}

function formatYmd(ms: number): string {
	const d = new Date(ms);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	return `${yyyy}${mm}${dd}`;
}

function dedupSlug(desired: string, seen: Set<string>): string {
	if (!seen.has(desired)) return desired;
	let i = 2;
	while (seen.has(`${desired}-${i}`)) i += 1;
	return `${desired}-${i}`;
}

/**
 * Make an OKF `type` safe to use as a folder name under `root`.
 *
 * We keep the original casing (the on-disk layout uses `Reference`,
 * `Experience`, `Opinion`, …) but neutralise any path-traversal trick:
 * a `type` like `../../tmp/evil` collapses to its last segment (`evil`)
 * and leading dots are stripped so it can't name a dot-folder or `..`.
 * An empty/dot-only result falls back to `Reference`.
 */
function sanitizeTypeFolder(type: string): string {
	const segment = type.split(/[\\/]/).pop() ?? "";
	const cleaned = segment.replace(/^\.+/, "");
	return cleaned.length > 0 ? cleaned.slice(0, 128) : "Reference";
}

// ─── helpers ──────────────────────────────────────────────────────────

async function walk(
	root: string,
	dir: string,
	recursive: boolean,
	visit: (filePath: string, relPath: string) => Promise<void>,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "manifest.json" || entry === "node_modules" || entry.startsWith(".")) continue;
		const fullPath = join(dir, entry);
		let s: Stats;
		try {
			s = await stat(fullPath);
		} catch {
			continue;
		}
		const rel = relative(root, fullPath).split(sep).join("/");
		if (s.isDirectory()) {
			if (recursive) await walk(root, fullPath, recursive, visit);
			continue;
		}
		if (s.isFile()) await visit(fullPath, rel);
	}
}
