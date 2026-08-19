/**
 * @melandlabs/okf — OKF v0.2 (Open Knowledge Format) importer / exporter.
 *
 * Public surface:
 *
 *   - low-level codec:           `okfToRawMessage`, `rawMessageToOkf`
 *   - front-matter parsing:      `parseOkf`, `parseOkfFrontMatter`,
 *                                `stringifyOkf`, `validateOkfFrontMatter`
 *   - package reader / writer:   `readOkfPackage`, `writeOkfPackage`
 *   - error / diagnostic types:  `OkfError`, `OkfIssue`
 *   - CLI:                       `parseOkfArgs`, `startOkf`, `printOkfHelp`
 *   - HTTP server routes:        `registerOkfRoutes` (subpath `@melandlabs/okf/http`)
 *   - MCP tools:                 `registerOkfTools` (subpath `@melandlabs/okf/mcp`)
 */

export {
	okfToRawMessage,
	rawMessageToOkf,
	okfTypeToFactType,
	factTypeToOkfType,
	extractMarkdownLinks,
	slugify,
	ingestOkfString,
} from "./codec.js";
export type {
	OkfToRawMessageOptions,
	OkfToRawMessageResult,
	RawMessageToOkfOptions,
	RawMessageToOkfResult,
} from "./codec.js";

export { parseOkf, parseOkfFrontMatter, stringifyOkf, validateOkfFrontMatter } from "./frontmatter.js";
export type { ParsedOkfDocument } from "./frontmatter.js";

export { readOkfPackage, writeOkfPackage } from "./package.js";
export type {
	ReadOkfPackageOptions,
	OkfPackageFile,
	ReadOkfPackageResult,
	WriteOkfPackageOptions,
	WriteOkfPackageResult,
} from "./package.js";

export { OkfError, okfIssue } from "./errors.js";
export type { OkfIssue, OkfIssueCode } from "./errors.js";

export {
	parseOkfArgs,
	startOkf,
	printOkfHelp,
} from "./cli.js";
export type {
	OkfAction,
	OkfCommonOptions,
	OkfIngestOptions,
	OkfEmitOptions,
	OkfValidateOptions,
	OkfInspectOptions,
	OkfHelpOptions,
	OkfOptions,
	OkfRunResult,
	OkfRunOptions,
	OkfIngestSummary,
	OkfEmitSummary,
	OkfValidateSummary,
	OkfInspectSummary,
	OkfInspectOutput,
} from "./cli.js";

// Re-export the contracts surface so consumers can build their own
// zod schemas on top of OKF without a separate install.
export type {
	OkfFrontMatter,
	OkfDocument,
	OkfPackageManifest,
	OkfSource,
	OkfVerification,
	OkfGenerated,
} from "@melandlabs/contracts";
export {
	isOkfType,
	OkfFrontMatterSchema,
	OkfDocumentSchema,
	OkfPackageManifestSchema,
	OKF_TYPES,
} from "@melandlabs/contracts";
