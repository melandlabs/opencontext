/**
 * OKF error + diagnostic types.
 *
 * `OkfError` carries an array of `OkfIssue`s so a single ingest can
 * surface every problem (missing field, bad format, unknown type) at
 * once instead of failing on the first one. The CLI emits these as the
 * `issues[]` field of the JSON envelope; the HTTP / MCP front-ends
 * surface them as `400 { error, issues }`.
 */

export type OkfIssueCode =
	| "missing_type"
	| "missing_generated_at"
	| "missing_generated_by"
	| "missing_resource"
	| "invalid_stale_after"
	| "invalid_generated_at"
	| "invalid_frontmatter"
	| "unknown_type"
	| "invalid_yaml"
	| "empty_body"
	| "io_error"
	| "conflict"
	| "schema_mismatch"
	| "slug_truncated"
	| "duplicate_resource";

export interface OkfIssue {
	/** Code identifying the issue class. */
	code: OkfIssueCode;
	/** Human-readable description of the problem. */
	message: string;
	/** Front-matter field the issue applies to (when scoped). */
	field?: string;
	/** File path the issue applies to (when scoped to a file). */
	file?: string;
	/** Line number in the source file (when known). */
	line?: number;
}

export class OkfError extends Error {
	public readonly code: OkfIssueCode;
	public readonly issues: OkfIssue[];

	constructor(message: string, options: { code?: OkfIssueCode; issues?: OkfIssue[]; cause?: unknown } = {}) {
		super(message);
		this.name = "OkfError";
		this.code = options.code ?? "invalid_frontmatter";
		this.issues = options.issues ?? [];
		if (options.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/**
 * Helper to build a single-issue `OkfError` quickly.
 */
export function okfIssue(issue: OkfIssue): OkfError {
	return new OkfError(issue.message, { code: issue.code, issues: [issue] });
}
