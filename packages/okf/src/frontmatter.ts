/**
 * OKF v0.2 front-matter parsing / serialization.
 *
 * An OKF document is a Markdown file with a YAML front-matter block
 * delimited by `---` fences. The body is the markdown that follows.
 *
 * This module is intentionally tolerant of unknown fields (downstream
 * emitters may add vendor-specific extension flags), but enforces the
 * v0.2 contract for the well-known keys.
 *
 * We use `yaml.parseDocument()` rather than `yaml.load()` so that:
 *   1. Unknown keys are preserved on the parsed object instead of being
 *      silently dropped, and the codec can stash them under
 *      `metadata.okfExtras`.
 *   2. `parseDocument()` exposes parse errors via `doc.errors[]` so we
 *      can surface them as `OkfIssue`s instead of throwing on a stray
 *      colon.
 *
 * The body is returned exactly as-is (no leading blank line stripped,
 * no trailing newline normalised). The codec normalises the body only
 * when re-emitting it.
 */

import { OkfFrontMatterSchema, type OkfFrontMatter } from "@melandlabs/contracts";
import { parseDocument, stringify as yamlStringify } from "yaml";
import { OkfError, type OkfIssue } from "./errors.js";

export interface ParsedOkfDocument {
	frontMatter: OkfFrontMatter;
	/** Raw Markdown body (no leading newline). */
	body: string;
}

const FENCE = "---";

/**
 * Parse an OKF document (raw file text) into structured front-matter
 * and body. Tolerant of missing fences (returns empty front-matter)
 * but throws `OkfError` on YAML parse failures.
 */
export function parseOkf(text: string): ParsedOkfDocument {
	const trimmed = text.replace(/^\uFEFF/, "");
	if (!trimmed.startsWith(`${FENCE}\n`) && !trimmed.startsWith(`${FENCE}\r\n`)) {
		// No front-matter fence at all — treat the whole file as body.
		return { frontMatter: {}, body: trimmed };
	}
	const newline = trimmed.startsWith(`${FENCE}\r\n`) ? "\r\n" : "\n";
	const closing = `${newline}${FENCE}`;
	const afterOpening = trimmed.slice(FENCE.length + newline.length);
	const closingIdx = afterOpening.indexOf(closing);
	if (closingIdx < 0) {
		// Unterminated front-matter — recover by treating the whole file
		// as body. Most often this happens when a user accidentally
		// opens a file with a `---` line that isn't a front-matter
		// fence (e.g. a Markdown horizontal rule).
		return { frontMatter: {}, body: trimmed };
	}
	const yamlSource = afterOpening.slice(0, closingIdx);
	const body = afterOpening.slice(closingIdx + closing.length);
	const frontMatter = parseOkfFrontMatter(yamlSource);
	return { frontMatter, body };
}

/**
 * Parse only the YAML source of an OKF front-matter block. Exposed so
 * `validate` can inspect fields without the surrounding Markdown.
 */
export function parseOkfFrontMatter(yamlSource: string): OkfFrontMatter {
	const doc = parseDocument(yamlSource, { keepSourceTokens: true });
	if (doc.errors.length > 0) {
		const first = doc.errors[0];
		throw new OkfError(`invalid YAML front-matter: ${first.message}`, {
			code: "invalid_yaml",
			issues: doc.errors.map((err) => ({
				code: "invalid_yaml" as const,
				message: err.message,
				line: err.linePos?.[0]?.line,
			})),
		});
	}
	const parsed = doc.toJS({ maxAliasCount: 0 });
	const result = OkfFrontMatterSchema.safeParse(parsed ?? {});
	if (!result.success) {
		const issues: OkfIssue[] = result.error.issues.map((issue) => ({
			code: "invalid_frontmatter" as const,
			message: issue.message,
			field: issue.path.join("."),
		}));
		throw new OkfError("invalid front-matter", { code: "invalid_frontmatter", issues });
	}
	return result.data;
}

/**
 * Validate a parsed OKF front-matter object. Returns a list of
 * `OkfIssue`s (warnings, not throws) for missing required fields,
 * unknown types, and malformed dates. The CLI/HTTP/MCP front-ends
 * surface these via the `issues[]` envelope.
 */
export function validateOkfFrontMatter(fm: OkfFrontMatter): OkfIssue[] {
	const issues: OkfIssue[] = [];
	if (!fm.type || typeof fm.type !== "string") {
		issues.push({
			code: "missing_type",
			message: "front-matter `type` is required",
			field: "type",
		});
	}
	if (!fm.generated?.at) {
		issues.push({
			code: "missing_generated_at",
			message: "front-matter `generated.at` is required to preserve the fact timestamp",
			field: "generated.at",
		});
	} else if (Number.isNaN(Date.parse(fm.generated.at))) {
		issues.push({
			code: "invalid_generated_at",
			message: `front-matter \`generated.at\` is not a valid ISO 8601 date: ${fm.generated.at}`,
			field: "generated.at",
		});
	}
	if (!fm.generated?.by) {
		issues.push({
			code: "missing_generated_by",
			message: "front-matter `generated.by` is required",
			field: "generated.by",
		});
	}
	if (fm.stale_after && Number.isNaN(Date.parse(fm.stale_after))) {
		issues.push({
			code: "invalid_stale_after",
			message: `front-matter \`stale_after\` is not a valid ISO 8601 date: ${fm.stale_after}`,
			field: "stale_after",
		});
	}
	if (fm.stale_after && fm.generated?.at) {
		const stale = Date.parse(fm.stale_after);
		const generated = Date.parse(fm.generated.at);
		if (Number.isFinite(stale) && Number.isFinite(generated) && stale < generated) {
			issues.push({
				code: "invalid_stale_after",
				message: "`stale_after` is earlier than `generated.at`",
				field: "stale_after",
			});
		}
	}
	return issues;
}

/**
 * Serialise an OKF document back to its wire form. The body is the
 * raw Markdown returned by callers (we don't normalise it here so the
 * codec can strip / insert a `# title` line deliberately).
 *
 * Trailing-newline normalisation: the body is reduced to a single
 * trailing newline (when non-empty) so round-trips preserve a stable
 * shape regardless of whether the caller already ended the body in
 * `\n` or not.
 */
export function stringifyOkf({ frontMatter, body }: ParsedOkfDocument): string {
	const yaml = yamlStringify(frontMatter as Record<string, unknown>, {
		lineWidth: 0,
		// Sort keys false so emit order is the insertion order on the
		// object — the codec hands us back the same shape it parsed.
		sortMapEntries: false,
		defaultStringType: "PLAIN",
		// Don't quote short plain scalars.
		defaultKeyType: "PLAIN",
	});
	const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
	const sep = trimmedBody.length > 0 ? "\n" : "";
	return `---\n${yaml}---\n${trimmedBody}${sep}`;
}

/**
 * Concat helpers used by the codec — separated out so the tests can
 * pin the exact body-prefix / body-suffix behaviour.
 */
export const BODY_DELIMITERS = {
	opening: `${FENCE}\n`,
	closing: `\n${FENCE}\n`,
} as const;
