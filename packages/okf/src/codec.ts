/**
 * OKF ↔ RawMessage field mapping.
 *
 * This is the single source of truth for the translation. The two
 * functions below are inverses — modulo the noted lossy round-trip
 * (`status: deprecated → archivedAt = now`).
 *
 * Mapping reference (see `docs/okf.md` for the full table):
 *
 *   type           → factType           (Reference/Concept → world,
 *                                       Experience/Episode → experience,
 *                                       Opinion/MentalModel/Belief → mental_model,
 *                                       unknown → world)
 *   resource       → messageId          (slug-ified, deduped with `-2`, `-3` suffix)
 *   generated.at   → timestamp          (ms)
 *   generated.by   → metadata.okfGenerator
 *   title + body   → content            (`# title\n\nbody` if title non-empty)
 *   description    → metadata.okfDescription
 *   tags           → metadata.okfTags
 *   sources[].r    → metadata.okfSources[] + first URL → attachments[0].url
 *   verified[].{by,at} → metadata.okfVerified[]
 *   status: draft  → metadata.okfDraft = true
 *   status: deprecated → archivedAt + deprecationReason = "okf:deprecated"
 *   stale_after    → metadata.okfStaleAfter
 *   superseded_by  → supersededBySummaryId (this record was replaced by it)
 *   supersedes     → metadata.okfSupersedes (inverse link; round-tripped verbatim)
 *   user_id / bot_id / platform → userId / botId / platform
 *   unknown front-matter fields → metadata.okfExtras (vendor-specific
 *                                 provenance flags ride along here)
 *   body markdown links → metadata.okfLinks[]
 */

import type { FactType, OkfDocument, OkfFrontMatter } from "@melandlabs/contracts";
import { isFactType } from "@melandlabs/contracts";
import type { RawMessage } from "@melandlabs/indexeddb";
import { OkfError, type OkfIssue, type OkfIssueCode } from "./errors.js";
import { type ParsedOkfDocument, parseOkf, validateOkfFrontMatter } from "./frontmatter.js";

/**
 * Field keys we recognise on the front-matter. Everything else is
 * preserved as `metadata.okfExtras` on ingest (so vendor-specific
 * extension flags survive the round-trip verbatim).
 */
const KNOWN_FM_KEYS = new Set([
	"type",
	"title",
	"description",
	"tags",
	"status",
	"stale_after",
	"generated",
	"verified",
	"sources",
	"supersedes",
	"superseded_by",
	"user_id",
	"bot_id",
	"platform",
]);

/** Map an OKF `type` to a `FactType` (the opencontext `world` / `experience` / `mental_model` union). */
export function okfTypeToFactType(type: string): FactType {
	switch (type) {
		case "Reference":
		case "Concept":
			return "world";
		case "Experience":
		case "Episode":
			return "experience";
		case "Opinion":
		case "MentalModel":
		case "Belief":
			return "mental_model";
		default:
			return "world";
	}
}

/** Inverse map of `okfTypeToFactType`. */
export function factTypeToOkfType(factType: FactType): string {
	switch (factType) {
		case "world":
			return "Reference";
		case "experience":
			return "Experience";
		case "mental_model":
			return "Opinion";
		default:
			return "Reference";
	}
}

/**
 * Issue codes that make an OKF document **unwriteable** as a fact.
 * Shared by `ingest` (skip + non-zero exit), `validate` (non-valid) and
 * the HTTP / MCP import paths (400) so every surface agrees on what
 * "required" means. Everything else (`missing_generated_by`,
 * `invalid_generated_at`, `invalid_stale_after`, …) is a soft warning
 * the store can still accept.
 */
export const OKF_BLOCKING_ISSUE_CODES: ReadonlySet<OkfIssueCode> = new Set<OkfIssueCode>([
	"missing_type",
	"missing_generated_at",
	"invalid_yaml",
	"invalid_frontmatter",
	"empty_body",
]);

/** True when an issue makes the document unwriteable (see `OKF_BLOCKING_ISSUE_CODES`). */
export function isBlockingOkfIssue(issue: OkfIssue): boolean {
	return OKF_BLOCKING_ISSUE_CODES.has(issue.code);
}

/**
 * Filter `RawMessage`s by OKF `type` values. Used by every export / emit
 * surface (CLI, HTTP, MCP) so they apply one identical filter.
 *
 * A record matches when its explicit `metadata.okfType` is in `types`,
 * or — when `okfType` is absent (records written before that field was
 * tracked) — when the inverse map of its `factType` is in `types`. An
 * empty / absent `types` list returns the input unchanged.
 */
export function filterRawMessagesByOkfType(
	rows: readonly RawMessage[],
	types: readonly string[] | null | undefined,
): RawMessage[] {
	if (!types || types.length === 0) return rows.slice();
	return rows.filter((r) => {
		const okfType =
			typeof (r.metadata as Record<string, unknown> | undefined)?.okfType === "string"
				? ((r.metadata as Record<string, unknown>).okfType as string)
				: factTypeToOkfType((r.factType as FactType) ?? "world");
		return types.includes(okfType);
	});
}

// ─── Ingest (OKF → RawMessage) ─────────────────────────────────────────

export interface OkfToRawMessageOptions {
	/** Fallback when the front-matter `user_id` is missing. Required. */
	userId?: string;
	/** Fallback for `bot_id`. Default: `"okf-import"`. */
	botId?: string;
	/** Fallback for `platform`. Default: `"okf"`. */
	platform?: string;
	/** If true, the file's mtime is used when `generated.at` is missing. Default: true. */
	useMtimeFallback?: boolean;
	/** File mtime in ms (used when `useMtimeFallback` is true and `generated.at` is missing). */
	mtimeMs?: number;
	/**
	 * Existing message ids in the destination store. When non-empty, the
	 * codec appends `-2`, `-3`, … if the slug-ified resource already
	 * exists. Default: empty (no dedup).
	 */
	existingIds?: Iterable<string>;
	/** Source file path (used for `okfSource` / issues). */
	file?: string;
}

export interface OkfToRawMessageResult {
	rawMessage: RawMessage;
	issues: OkfIssue[];
	/** The slug-ified resource id (post-dedup). */
	messageId: string;
}

/**
 * Convert an OKF document to a `RawMessage`. The required fields are
 * validated here; missing required fields surface as `OkfIssue`s
 * (warnings) rather than throwing, so the CLI can continue with the
 * rest of the package.
 */
export function okfToRawMessage(
	parsed: ParsedOkfDocument,
	options: OkfToRawMessageOptions = {},
): OkfToRawMessageResult {
	const { frontMatter: fm, body } = parsed;
	const issues: OkfIssue[] = validateOkfFrontMatter(fm).map((issue) => ({
		...issue,
		...(options.file ? { file: options.file } : {}),
	}));
	if (body.trim().length === 0) {
		issues.push({
			code: "empty_body",
			message: "OKF body is empty",
			...(options.file ? { file: options.file } : {}),
		});
	}

	const userId = fm.user_id ?? options.userId ?? "";
	const botId = fm.bot_id ?? options.botId ?? "okf-import";
	const platform = fm.platform ?? options.platform ?? "okf";

	if (!userId) {
		throw new OkfError("okfToRawMessage requires `userId` (front-matter `user_id` or options.userId)", {
			code: "missing_resource",
		});
	}

	// 1. resource → messageId (slug + dedup). When the front-matter
	//    declares a `resource` (e.g. an OKF doc we emitted ourselves in a
	//    prior round-trip) honour it verbatim so re-ingesting produces the
	//    same messageId and upserts in place. The SQLite store resolves
	//    `INSERT … ON CONFLICT(message_id)` against the persisted row, so
	//    we deliberately skip the dedup suffix when the source document
	//    already pins a resource — appending `-2` would create a new row
	//    instead of updating the canonical one.
	const explicitResource =
		typeof fm.resource === "string" && fm.resource.length > 0 ? fm.resource : undefined;
	const rawSlugSource =
		explicitResource ?? (fm.type && body ? `${fm.type}-${firstLine(body)}` : (fm.type ?? "okf-doc"));
	const messageId = explicitResource
		? slugify(explicitResource)
		: dedupSlug(slugify(rawSlugSource), options.existingIds);
	if (rawSlugSource.length > SLUG_MAX_LENGTH) {
		// The slug was truncated; two distinct inputs that share the same
		// leading SLUG_MAX_LENGTH characters will collide on disk. Surface
		// a warning so the caller can decide whether to shorten `resource`.
		issues.push({
			code: "slug_truncated",
			message: `front-matter resource was truncated to ${SLUG_MAX_LENGTH} chars — distinct docs may collide`,
			...(options.file ? { file: options.file } : {}),
		});
	}

	// 2. generated.at → timestamp (ms).
	const timestamp = fm.generated?.at
		? Date.parse(fm.generated.at)
		: options.useMtimeFallback !== false && options.mtimeMs
			? options.mtimeMs
			: Date.now();

	// 3. content = `# title\n\nbody` (or just `body` if no title). We
	//    only strip *newlines* on the edges (not arbitrary whitespace)
	//    so indentation inside code blocks survives a round-trip. The
	//    same rule is applied in `stringifyOkf` for the inverse path.
	const strippedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
	const content = fm.title ? `# ${fm.title}\n\n${strippedBody}` : strippedBody;

	// 4. metadata.okfExtras = every non-recognised front-matter key.
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fm)) {
		if (!KNOWN_FM_KEYS.has(key)) extras[key] = value;
	}

	// 5. metadata.okfLinks = markdown links to other `.md` files.
	const links = extractMarkdownLinks(body);

	// 6. Pull through the optional fields. Unknown front-matter keys land
	//    under `metadata.okfExtras` so they don't pollute the top-level
	//    shape and downstream emitters can recognise the contract.
	const metadata: Record<string, unknown> = {
		...(Object.keys(extras).length > 0 ? { okfExtras: extras } : {}),
		...(fm.generated?.by ? { okfGenerator: fm.generated.by } : {}),
		...(fm.type ? { okfType: fm.type } : {}),
		...(fm.description ? { okfDescription: fm.description } : {}),
		...(Array.isArray(fm.tags) ? { okfTags: fm.tags } : {}),
		...(Array.isArray(fm.verified) || fm.verified ? { okfVerified: normaliseVerified(fm.verified) } : {}),
		...(Array.isArray(fm.sources) ? { okfSources: fm.sources.map((s) => s.resource) } : {}),
		...(fm.stale_after ? { okfStaleAfter: fm.stale_after } : {}),
		...(links.length > 0 ? { okfLinks: links } : {}),
		// 9b. `supersedes` is the inverse of `superseded_by`: this record
		//     replaces the referenced one. We can't mutate that other
		//     record from a single-doc conversion, so we stash the link
		//     verbatim and let the emit side write it back as `supersedes`.
		...(pickFirst(fm.supersedes) ? { okfSupersedes: pickFirst(fm.supersedes) } : {}),
	};

	// 7. status: draft → metadata.okfDraft = true.
	if (fm.status === "draft") {
		metadata.okfDraft = true;
	}

	// 8. status: deprecated → archivedAt = now, deprecationReason.
	let archivedAt: number | undefined;
	let deprecationReason: string | undefined;
	if (fm.status === "deprecated") {
		archivedAt = Date.now();
		deprecationReason = "okf:deprecated";
	}

	// 9. type → factType. The original `type` is preserved separately
	//    via `metadata.okfType` so the round-trip is loss-free.
	const factType: FactType = okfTypeToFactType(fm.type ?? "Reference");

	// 10. `superseded_by` → supersededBySummaryId (this record was
	//     replaced by the referenced summary). `supersedes` is the
	//     inverse relation and is preserved under `metadata.okfSupersedes`
	//     (see step 9b) for a loss-free round-trip.
	const supersededBySummaryId = pickFirst(fm.superseded_by);

	// 11. First URL source → attachments[0].url.
	const firstUrlSource = fm.sources?.find((s) => /^https?:\/\//i.test(s.resource))?.resource;
	const attachments = firstUrlSource ? [{ name: "okf-source", url: firstUrlSource }] : undefined;

	const rawMessage: RawMessage = {
		messageId,
		userId,
		botId,
		platform,
		timestamp,
		content,
		factType,
		metadata,
		createdAt: timestamp,
		...(attachments ? { attachments } : {}),
		...(archivedAt !== undefined ? { archivedAt } : {}),
		...(deprecationReason ? { deprecationReason } : {}),
		...(supersededBySummaryId ? { supersededBySummaryId: supersededBySummaryId } : {}),
	};

	return { rawMessage, issues, messageId };
}

// ─── Emit (RawMessage → OKF) ─────────────────────────────────────────

export interface RawMessageToOkfOptions {
	/** Package version, used as the `generated.by` fallback. */
	packageVersion?: string;
	/**
	 * Force a specific OKF `type` instead of the inverse-mapped one.
	 * Useful when round-tripping an OKF document with a non-canonical
	 * `type` value (anything outside `Reference` / `Experience` /
	 * `Opinion`) that the caller wants preserved verbatim.
	 */
	overrideType?: string;
}

export interface RawMessageToOkfResult {
	document: OkfDocument;
	/** The body content (after stripping the title heading). */
	body: string;
	/** The title derived from the body's first `#` heading (when present). */
	title?: string;
}

/**
 * Convert a `RawMessage` into an OKF document. Inverse of
 * `okfToRawMessage`; see the module header for the field map.
 */
export function rawMessageToOkf(
	rawMessage: RawMessage,
	options: RawMessageToOkfOptions = {},
): RawMessageToOkfResult {
	const metadata = (rawMessage.metadata ?? {}) as Record<string, unknown>;

	// 1. messageId → resource. Strip any `-2`, `-3` dedup suffix so the
	//    emitted resource is the canonical one.
	const resource = rawMessage.messageId;

	// 2. timestamp → generated.at (ISO 8601).
	const generatedAt = new Date(rawMessage.timestamp ?? Date.now()).toISOString();
	const generator =
		typeof metadata.okfGenerator === "string" && metadata.okfGenerator.length > 0
			? metadata.okfGenerator
			: `opencontext@${options.packageVersion ?? "0.0.0"}`;

	// 3. body: strip the leading `# title` line if present, normalise
	//    so we don't double-stamp front-matter.
	let body = rawMessage.content ?? "";
	if (body.startsWith("---\n")) {
		// Defensive: drop any embedded front-matter so we don't double-emit.
		const closing = body.indexOf("\n---\n");
		body = closing >= 0 ? body.slice(closing + 5) : body;
	}
	body = body.replace(/^\n+/, "");

	// 4. title: prefer explicit metadata, then the first `# heading` line.
	let title: string | undefined;
	const headingMatch = body.match(/^#\s+(.+?)\s*$/m);
	if (headingMatch) {
		title = headingMatch[1].trim();
		body = body.replace(/^#\s+.+?\n+/, "");
	}
	if (typeof metadata.okfTitle === "string") {
		title = metadata.okfTitle as string;
	}

	// 5. type: prefer override, then metadata.okfType, then inverse map.
	const okfType =
		options.overrideType ??
		(typeof metadata.okfType === "string"
			? metadata.okfType
			: factTypeToOkfType(rawMessage.factType ?? "world"));

	// 6. status: draft / deprecated / active. `active` is the
	//    default-emitted value when the source record isn't a draft
	//    and isn't archived — listing it explicitly here keeps the
	//    schema enum honest.
	let status: OkfFrontMatter["status"];
	if (metadata.okfDraft === true) {
		status = "draft";
	} else if (rawMessage.archivedAt !== undefined || rawMessage.supersededBySummaryId) {
		status = "deprecated";
	} else {
		status = "active";
	}

	// 7. Reconstruct front-matter with the known fields.
	const frontMatter: OkfFrontMatter = {
		type: okfType,
		// Write `resource` into the front-matter so a downstream `okf
		// ingest` can honour it as the canonical messageId and upsert
		// in place during a round-trip. The document-level field is
		// kept as well so legacy readers that look at `OkfDocument.resource`
		// continue to work.
		resource,
		...(title ? { title } : {}),
		...(typeof metadata.okfDescription === "string" ? { description: metadata.okfDescription } : {}),
		generated: { by: generator, at: generatedAt },
		...(Array.isArray(metadata.okfTags) ? { tags: [...(metadata.okfTags as string[])] } : {}),
		...(Array.isArray(metadata.okfVerified)
			? { verified: [...(metadata.okfVerified as Array<{ by: string; at?: string }>)] }
			: {}),
		...(Array.isArray(metadata.okfSources)
			? {
					sources: (metadata.okfSources as string[]).map((resource) => ({
						resource,
					})),
				}
			: {}),
		...(typeof metadata.okfStaleAfter === "string" ? { stale_after: metadata.okfStaleAfter } : {}),
		...(rawMessage.supersededBySummaryId ? { superseded_by: rawMessage.supersededBySummaryId } : {}),
		// Inverse link (see ingest step 9b): write it back as `supersedes`
		// so the relation survives the round-trip with the correct direction.
		...(typeof metadata.okfSupersedes === "string" ? { supersedes: metadata.okfSupersedes } : {}),
		...(status ? { status } : {}),
	};

	// 8. OKF has no standard user/bot/platform field — stash them under
	//    `metadata.okfExtras` so the round-trip preserves them. The
	//    *incoming* front-matter may have them at the top level, so we
	//    keep that shape on emit too.
	if (rawMessage.userId) {
		(frontMatter as Record<string, unknown>).user_id = rawMessage.userId;
	}
	if (rawMessage.botId) {
		(frontMatter as Record<string, unknown>).bot_id = rawMessage.botId;
	}
	if (rawMessage.platform) {
		(frontMatter as Record<string, unknown>).platform = rawMessage.platform;
	}

	// 9. Stash the rest of the metadata under okfExtras so we preserve
	//    everything else verbatim. Skip okf-prefixed keys we already
	//    surfaced.
	for (const [key, value] of Object.entries(metadata)) {
		if (KNOWN_METADATA_KEYS.has(key)) continue;
		if (key === "okfExtras" && value && typeof value === "object") {
			// Splice the saved extras back at the top level.
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (!KNOWN_FM_KEYS.has(k)) {
					(frontMatter as Record<string, unknown>)[k] = v;
				}
			}
			continue;
		}
		if (KNOWN_FM_KEYS.has(key)) continue;
		(frontMatter as Record<string, unknown>)[key] = value;
	}
	// Also propagate okfTitle (not in known-FM set) so a custom title
	// survives a round-trip.
	if (typeof metadata.okfTitle === "string") {
		(frontMatter as Record<string, unknown>).title = metadata.okfTitle;
	}

	const document: OkfDocument = {
		frontMatter,
		body,
		...(resource ? { resource } : {}),
	};

	return { document, body, title };
}

/** Set of `metadata.*` keys that the codec already surfaces as their own front-matter field. */
const KNOWN_METADATA_KEYS = new Set<string>([
	"okfGenerator",
	"okfType",
	"okfDescription",
	"okfTags",
	"okfVerified",
	"okfSources",
	"okfStaleAfter",
	"okfLinks",
	"okfDraft",
	"okfTitle",
	"okfSupersedes",
]);

// ─── helpers ──────────────────────────────────────────────────────────

/** Slug-ify a string into a safe messageId. */
export const SLUG_MAX_LENGTH = 80;

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, SLUG_MAX_LENGTH);
	return slug || "okf-doc";
}

/**
 * First non-empty line of a markdown body, trimmed. Used as fallback
 * for the slug when there's no front-matter title.
 */
function firstLine(body: string): string {
	const line = body.trim().split(/\r?\n/, 1)[0] ?? "";
	return line.replace(/^#+\s*/, "").trim();
}

/**
 * If `desired` collides with an existing id, append `-2`, `-3`, etc.
 */
function dedupSlug(desired: string, existingIds?: Iterable<string>): string {
	if (!existingIds) return desired;
	const seen = new Set<string>();
	for (const id of existingIds) seen.add(id);
	if (!seen.has(desired)) return desired;
	let i = 2;
	while (seen.has(`${desired}-${i}`)) i += 1;
	return `${desired}-${i}`;
}

/**
 * Normalise verified to an array of `{by, at?}` even when a single
 * object was supplied.
 */
function normaliseVerified(verified: OkfFrontMatter["verified"]): Array<{ by: string; at?: string }> {
	if (!verified) return [];
	if (Array.isArray(verified)) return verified.map((v) => ({ by: v.by, at: v.at }));
	return [{ by: verified.by, at: verified.at }];
}

/**
 * Return the first string of a `string | string[]` front-matter link.
 */
function pickFirst(value: string | string[] | undefined): string | undefined {
	if (!value) return undefined;
	if (Array.isArray(value)) return value[0];
	return value;
}

/**
 * Extract markdown links `[label](target)` from a body. Only `.md`
 * links are surfaced as `okfLinks[]` (per the v0.2 spec).
 *
 * Targets may themselves contain balanced parentheses (Wikipedia-style
 * URLs like `(https://en.wikipedia.org/wiki/Foo_(bar))`), so we walk
 * past matched pairs instead of using a naive `[^)]+` class.
 */
export function extractMarkdownLinks(body: string): Array<{ label: string; target: string }> {
	const links: Array<{ label: string; target: string }> = [];
	const re = /\[([^\[\]]+)\]\(/g;
	for (const labelMatch of body.matchAll(re)) {
		const label = labelMatch[1] ?? "";
		const openIdx = labelMatch.index ?? -1;
		if (openIdx < 0) continue;
		// Walk forward from the `(` that follows the label, tracking depth.
		const start = openIdx + labelMatch[0].length;
		let depth = 1;
		let i = start;
		while (i < body.length && depth > 0) {
			const ch = body[i];
			if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
			i += 1;
			if (depth === 0) break;
		}
		if (depth !== 0) continue;
		const target = body.slice(start, i - 1).trim();
		if (!target) continue;
		if (target.endsWith(".md") || target.includes(".md#")) {
			links.push({ label, target });
		}
	}
	return links;
}

/** Re-export validators so consumers can skip the parser. */
export { parseOkf, parseOkfFrontMatter, validateOkfFrontMatter, stringifyOkf } from "./frontmatter.js";

/** Re-export `isFactType` so callers can pre-validate. */
export { isFactType };

/** Convenience: ingest a raw OKF string (combined parse + codec). */
export function ingestOkfString(text: string, options: OkfToRawMessageOptions = {}): OkfToRawMessageResult {
	return okfToRawMessage(parseOkf(text), options);
}
