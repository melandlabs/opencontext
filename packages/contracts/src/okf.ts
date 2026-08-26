/**
 * OKF v0.2 — Open Knowledge Format contract.
 *
 * OKF is a Markdown-with-YAML-front-matter document format used to
 * interchange knowledge between opencontext and external wiki / note
 * tools. The front-matter fields
 * defined here are the v0.2 specification; the runtime codecs in
 * `@melandlabs/okf` translate them to / from `RawMessage` records.
 *
 * Field reference (v0.2):
 *
 *   - `type`              — Concept classification. Required.
 *                           Canonical: `Reference`, `Concept`,
 *                           `Experience`, `Episode`, `Opinion`,
 *                           `MentalModel`, `Belief`. Unknown values
 *                           are preserved verbatim and surface as a
 *                           `unknown_type` warning on validate.
 *   - `title`             — Human-readable short title.
 *   - `description`       — One-sentence summary.
 *   - `tags`              — Free-form string list.
 *   - `status`            — `draft` | `deprecated` | `active` (default).
 *   - `stale_after`       — ISO 8601 date after which the fact is stale.
 *   - `generated.{by,at}` — Provenance: who created this doc and when.
 *                           `at` is required to back the `timestamp`
 *                           field on `RawMessage`.
 *   - `verified[].{by,at}` — Optional review chain.
 *   - `sources[].resource` — Originating resources (URLs, paths, ids).
 *   - `supersedes` / `superseded_by` — Front-matter links connecting
 *                                       successor / predecessor docs.
 *
 * Anything outside the keys above is preserved by the codec into
 * `metadata.okfExtras` so a round-trip is loss-free. Vendor-specific
 * extensions (e.g. an emitter's own provenance flags) are *not* lifted
 * into first-class fields here — they ride along in `okfExtras` like
 * any other unknown key.
 */

import { z } from "zod";

/**
 * Canonical OKF front-matter `type` values, plus the opencontext cache
 * for round-tripping. Front-matter that names an unknown type is still
 * accepted (and preserved verbatim) — we just surface a warning.
 */
export const OKF_TYPES = [
	"Reference",
	"Concept",
	"Experience",
	"Episode",
	"Opinion",
	"MentalModel",
	"Belief",
] as const;

export type OkfType = (typeof OKF_TYPES)[number];

export function isOkfType(value: unknown): value is OkfType {
	return typeof value === "string" && (OKF_TYPES as readonly string[]).includes(value);
}

const OkfSourceSchema = z.object({
	// Resource identifier: URL, file path, or platform-specific id.
	resource: z.string().min(1),
	// Free-form metadata about the source (label, captured-at, etc.).
	// Intentional `Record<string, unknown>` — emitters may add their
	// own keys; we preserve them verbatim.
	title: z.string().optional(),
	notes: z.string().optional(),
});

export type OkfSource = z.infer<typeof OkfSourceSchema>;

const OkfVerificationSchema = z.object({
	by: z.string().min(1),
	at: z.string().optional(),
});

export type OkfVerification = z.infer<typeof OkfVerificationSchema>;

const OkfGeneratedSchema = z.object({
	by: z.string().min(1),
	at: z.string().min(1),
});

export type OkfGenerated = z.infer<typeof OkfGeneratedSchema>;

/**
 * OKF v0.2 front-matter schema. Parsed via `yaml.parseDocument()` so
 * unknown fields are preserved on the parsed object (the codec stashes
 * them under `metadata.okfExtras`).
 *
 * `type` is the only hard requirement — every other field is optional.
 * Required fields that downstream code can't reconstruct from
 * `generated.at` will surface as `OkfIssue` warnings, not throws.
 */
export const OkfFrontMatterSchema = z
	.object({
		type: z.string().min(1).optional(),
		title: z.string().optional(),
		description: z.string().optional(),
		tags: z.array(z.string()).optional(),
		status: z.enum(["draft", "deprecated", "active"]).optional(),
		stale_after: z.string().optional(),
		generated: OkfGeneratedSchema.optional(),
		verified: z.union([OkfVerificationSchema, z.array(OkfVerificationSchema)]).optional(),
		sources: z.array(OkfSourceSchema).optional(),
		// Stable per-package identifier. The opencontext codec honours this
		// field on ingest so a round-trip (emit → ingest) produces the
		// same messageId and upserts in place; when absent the codec
		// falls back to a slug derived from `type` + first body line.
		resource: z.string().min(1).optional(),
		// Front-matter links.
		supersedes: z.union([z.string(), z.array(z.string())]).optional(),
		superseded_by: z.union([z.string(), z.array(z.string())]).optional(),
		// Identity / platform fallbacks (CLI flags still take precedence).
		user_id: z.string().optional(),
		bot_id: z.string().optional(),
		platform: z.string().optional(),
	})
	.passthrough();

export type OkfFrontMatter = z.infer<typeof OkfFrontMatterSchema>;

/**
 * A full OKF document = parsed front-matter + body markdown.
 *
 * `body` is the raw Markdown after the front-matter fence (no leading
 * blank line preserved). The codec normalises the title into the body
 * (and back) so re-emitted documents keep their `# Heading` line.
 */
export interface OkfDocument {
	/** Front-matter (parsed). Always present, even if empty. */
	frontMatter: OkfFrontMatter;
	/** Markdown body (everything after the closing `---` fence). */
	body: string;
	/**
	 * Optional resource id (mirrors front-matter `resource` when present,
	 * otherwise the slug used when the doc was written). The codec
	 * promotes this to `RawMessage.messageId` on ingest.
	 */
	resource?: string;
}

/**
 * Schema for the JSON-serialised form of an OKF document. Used by the
 * HTTP / MCP transport so the wire shape is visible in OpenAPI docs.
 */
export const OkfDocumentSchema = z.object({
	frontMatter: OkfFrontMatterSchema,
	body: z.string(),
	resource: z.string().optional(),
});

/**
 * A Knowledge Package is a directory of `.md` files plus a `manifest.json`
 * that summarises the contents. The manifest is **optional** on read
 * (the codec will infer counts) but **always written** on emit so
 * downstream tools can skip the per-file scan.
 */
export interface OkfPackageManifest {
	schema: "okf/v0.2";
	name: string;
	generatedAt: string; // ISO 8601
	generatedBy: string;
	okfConceptCount: number;
	okfTypeCounts: Record<string, number>;
	sources: string[];
	userIds: string[];
	platforms: string[];
	files: string[];
}

export const OkfPackageManifestSchema = z.object({
	schema: z.literal("okf/v0.2"),
	name: z.string().min(1),
	generatedAt: z.string().min(1),
	generatedBy: z.string().min(1),
	okfConceptCount: z.number().int().min(0),
	okfTypeCounts: z.record(z.string(), z.number().int().min(0)),
	sources: z.array(z.string()),
	userIds: z.array(z.string()),
	platforms: z.array(z.string()),
	files: z.array(z.string()),
});

export {
	OkfSourceSchema as OkfSourceObjectSchema,
	OkfVerificationSchema as OkfVerificationEntrySchema,
	OkfGeneratedSchema as OkfGeneratedInfoSchema,
};
