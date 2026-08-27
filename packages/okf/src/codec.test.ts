import type { RawMessage } from "@melandlabs/indexeddb";
import { describe, expect, it } from "vitest";
import {
	OKF_BLOCKING_ISSUE_CODES,
	extractMarkdownLinks,
	factTypeToOkfType,
	filterRawMessagesByOkfType,
	isBlockingOkfIssue,
	okfToRawMessage,
	okfTypeToFactType,
	rawMessageToOkf,
	slugify,
} from "./codec.js";

describe("okfTypeToFactType", () => {
	it("maps Reference / Concept to world", () => {
		expect(okfTypeToFactType("Reference")).toBe("world");
		expect(okfTypeToFactType("Concept")).toBe("world");
	});
	it("maps Experience / Episode to experience", () => {
		expect(okfTypeToFactType("Experience")).toBe("experience");
		expect(okfTypeToFactType("Episode")).toBe("experience");
	});
	it("maps Opinion / MentalModel / Belief to mental_model", () => {
		expect(okfTypeToFactType("Opinion")).toBe("mental_model");
		expect(okfTypeToFactType("MentalModel")).toBe("mental_model");
		expect(okfTypeToFactType("Belief")).toBe("mental_model");
	});
	it("maps Decision / Project to mental_model", () => {
		expect(okfTypeToFactType("Decision")).toBe("mental_model");
		expect(okfTypeToFactType("Project")).toBe("mental_model");
	});
	it("maps Person to world", () => {
		expect(okfTypeToFactType("Person")).toBe("world");
	});
	it("maps unknown types to world", () => {
		expect(okfTypeToFactType("WhateverNewType")).toBe("world");
	});
});

describe("factTypeToOkfType", () => {
	it("is the inverse of okfTypeToFactType for the canonical trio", () => {
		expect(factTypeToOkfType("world")).toBe("Reference");
		expect(factTypeToOkfType("experience")).toBe("Experience");
		expect(factTypeToOkfType("mental_model")).toBe("Opinion");
	});
});

describe("slugify", () => {
	it("lowercases and dashes", () => {
		expect(slugify("Hello World!")).toBe("hello-world");
	});
	it("strips multibyte punctuation but keeps ASCII letters", () => {
		// NFKD normalisation decomposes "é" into "e" + the combining acute
		// accent, so the regex's non-word-class strip removes the accent
		// but the ASCII "e" survives.
		expect(slugify("café! ¡Hola!")).toBe("cafe-hola");
	});
	it("returns a fallback when the result is empty", () => {
		expect(slugify("!!!")).toBe("okf-doc");
	});
});

describe("extractMarkdownLinks", () => {
	it("returns links to .md files only", () => {
		const body = "see [foo](Reference/foo.md) and [home](https://example.com) and [a](b/c.md)";
		const links = extractMarkdownLinks(body);
		expect(links).toEqual([
			{ label: "foo", target: "Reference/foo.md" },
			{ label: "a", target: "b/c.md" },
		]);
	});

	it("handles .md targets with balanced parentheses", () => {
		const body = "see [x](Reference/foo_(draft).md) and [y](other.md)";
		const links = extractMarkdownLinks(body);
		expect(links).toEqual([
			{ label: "x", target: "Reference/foo_(draft).md" },
			{ label: "y", target: "other.md" },
		]);
	});

	it("ignores link targets without balanced parens", () => {
		const body = "see [broken](Reference/foo.md (missing close)";
		const links = extractMarkdownLinks(body);
		expect(links).toEqual([]);
	});
});

describe("okfToRawMessage", () => {
	it("maps required fields to RawMessage", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "hello world",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.messageId).toMatch(/^reference-hello-world/);
		expect(result.rawMessage.timestamp).toBe(Date.parse("2026-08-19T10:00:00Z"));
		expect(result.rawMessage.factType).toBe("world");
		expect(result.rawMessage.content).toBe("hello world");
		expect(result.rawMessage.userId).toBe("u-1");
		expect(result.rawMessage.botId).toBe("okf-import");
		expect(result.rawMessage.platform).toBe("okf");
	});

	it("uses front-matter user_id / bot_id / platform when provided", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				user_id: "u-fm",
				bot_id: "b-fm",
				platform: "p-fm",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "hi",
		};
		const result = okfToRawMessage(parsed, { userId: "u-fallback" });
		expect(result.rawMessage.userId).toBe("u-fm");
		expect(result.rawMessage.botId).toBe("b-fm");
		expect(result.rawMessage.platform).toBe("p-fm");
	});

	it("prepends `# title` to the content when title is set", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				title: "Project Acronym",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "OKF = Open Knowledge Format.\n",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.rawMessage.content).toBe("# Project Acronym\n\nOKF = Open Knowledge Format.");
	});

	it("maps description, tags, sources, verified, status", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				description: "an acronym",
				tags: ["acronym", "okf"],
				sources: [{ resource: "https://example.com/spec" }, { resource: "doc.md" }],
				verified: [{ by: "reviewer", at: "2026-08-19T10:00:00Z" }],
				status: "draft",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.rawMessage.metadata?.okfDescription).toBe("an acronym");
		expect(result.rawMessage.metadata?.okfTags).toEqual(["acronym", "okf"]);
		expect(result.rawMessage.metadata?.okfSources).toEqual(["https://example.com/spec", "doc.md"]);
		expect(result.rawMessage.metadata?.okfVerified).toEqual([{ by: "reviewer", at: "2026-08-19T10:00:00Z" }]);
		expect(result.rawMessage.metadata?.okfDraft).toBe(true);
		// First URL source → attachments[0].url
		expect(result.rawMessage.attachments?.[0]?.url).toBe("https://example.com/spec");
	});

	it("maps status: deprecated to archivedAt + deprecationReason", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				status: "deprecated",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.rawMessage.archivedAt).toBeDefined();
		expect(result.rawMessage.deprecationReason).toBe("okf:deprecated");
	});

	it("maps stale_after and preserves unknown vendor fields", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				stale_after: "2027-01-01",
				// Vendor-specific flags the OKF codec does not own —
				// they should ride along in `metadata` verbatim instead
				// of being lifted into first-class fields.
				vendor_provenance: true,
				translation_pending_locale: "zh-CN",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.rawMessage.metadata?.okfStaleAfter).toBe("2027-01-01");
		const extras = (result.rawMessage.metadata as Record<string, unknown> | undefined)?.okfExtras as
			| Record<string, unknown>
			| undefined;
		expect(extras?.vendor_provenance).toBe(true);
		expect(extras?.translation_pending_locale).toBe("zh-CN");
	});

	it("maps superseded_by to supersededBySummaryId", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				superseded_by: "Reference/foo-2",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.rawMessage.supersededBySummaryId).toBe("Reference/foo-2");
	});

	it("preserves unknown front-matter fields under metadata.okfExtras", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
				custom_field: "hello",
			},
			body: "body",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		// `custom_field` is in metadata but not in the recognised set —
		// it should ride along under `metadata.okfExtras` so downstream
		// emitters can detect and round-trip it.
		const meta = result.rawMessage.metadata as Record<string, unknown> | undefined;
		const extras = meta?.okfExtras as Record<string, unknown> | undefined;
		expect(extras?.custom_field).toBe("hello");
	});

	it("dedupes the messageId against existingIds", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "hello world",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1", existingIds: ["reference-hello-world"] });
		expect(result.messageId).toBe("reference-hello-world-2");
	});

	it("returns missing_type + missing_generated_at issues", () => {
		const parsed = { frontMatter: {}, body: "" };
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		expect(result.issues.some((i) => i.code === "missing_type")).toBe(true);
		expect(result.issues.some((i) => i.code === "missing_generated_at")).toBe(true);
		expect(result.issues.some((i) => i.code === "empty_body")).toBe(true);
	});

	it("extracts markdown links to .md files into metadata.okfLinks", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "see [foo](Reference/foo.md) and [home](https://example.com)",
		};
		const result = okfToRawMessage(parsed, { userId: "u-1" });
		const meta = result.rawMessage.metadata as Record<string, unknown> | undefined;
		expect(meta?.okfLinks).toEqual([{ label: "foo", target: "Reference/foo.md" }]);
	});
});

describe("rawMessageToOkf", () => {
	const baseRaw: RawMessage = {
		messageId: "reference-foo",
		userId: "u-1",
		botId: "okf-import",
		platform: "okf",
		timestamp: Date.parse("2026-08-19T10:00:00Z"),
		content: "hello world",
		factType: "world",
		createdAt: Date.parse("2026-08-19T10:00:00Z"),
	};

	it("maps Required fields to front-matter", () => {
		// botId is the default "okf-import", so metadata.okfGenerator
		// is not set — the generator falls back to "opencontext@<ver>".
		const { document } = rawMessageToOkf(baseRaw, { packageVersion: "1.2.3" });
		expect(document.frontMatter.type).toBe("Reference");
		expect(document.frontMatter.generated?.at).toBe("2026-08-19T10:00:00.000Z");
		expect(document.frontMatter.generated?.by).toBe("opencontext@1.2.3");
		// user_id / bot_id / platform are NOT a standard OKF field, so
		// they end up at the top level for round-trip preservation.
		expect((document.frontMatter as Record<string, unknown>).user_id).toBe("u-1");
		expect((document.frontMatter as Record<string, unknown>).bot_id).toBe("okf-import");
		expect((document.frontMatter as Record<string, unknown>).platform).toBe("okf");
	});

	it("uses okfGenerator as the generated.by when set", () => {
		const { document } = rawMessageToOkf(
			{
				...baseRaw,
				metadata: { okfGenerator: "external-tool-2.0" },
			},
			{ packageVersion: "1.2.3" },
		);
		expect(document.frontMatter.generated?.by).toBe("external-tool-2.0");
	});

	it("falls back to opencontext@<version> when no okfGenerator", () => {
		const { document } = rawMessageToOkf(baseRaw, { packageVersion: "1.2.3" });
		expect(document.frontMatter.generated?.by).toBe("opencontext@1.2.3");
	});

	it("extracts title from the first # heading line", () => {
		const { document, title } = rawMessageToOkf({
			...baseRaw,
			content: "# Project Acronym\n\nOKF = Open Knowledge Format.\n",
		});
		expect(title).toBe("Project Acronym");
		expect(document.body).toBe("OKF = Open Knowledge Format.\n");
	});

	it("maps factType to okf type", () => {
		const { document: worldDoc } = rawMessageToOkf({ ...baseRaw, factType: "world" });
		expect(worldDoc.frontMatter.type).toBe("Reference");
		const { document: xpDoc } = rawMessageToOkf({ ...baseRaw, factType: "experience" });
		expect(xpDoc.frontMatter.type).toBe("Experience");
		const { document: bmDoc } = rawMessageToOkf({ ...baseRaw, factType: "mental_model" });
		expect(bmDoc.frontMatter.type).toBe("Opinion");
	});

	it("reads metadata.okfType as an override", () => {
		const { document } = rawMessageToOkf({
			...baseRaw,
			factType: "world",
			metadata: { okfType: "Concept" },
		});
		expect(document.frontMatter.type).toBe("Concept");
	});

	it("maps archivedAt and supersededBySummaryId to status: deprecated", () => {
		const { document } = rawMessageToOkf({
			...baseRaw,
			archivedAt: Date.now(),
			deprecationReason: "anything",
			supersededBySummaryId: "Reference/foo-2",
		});
		expect(document.frontMatter.status).toBe("deprecated");
	});

	it("maps metadata.okfDraft to status: draft", () => {
		const { document } = rawMessageToOkf({
			...baseRaw,
			metadata: { okfDraft: true },
		});
		expect(document.frontMatter.status).toBe("draft");
	});

	it("maps metadata.okfVerified, okfSources, okfTags back to front-matter", () => {
		const { document } = rawMessageToOkf({
			...baseRaw,
			metadata: {
				okfTags: ["a", "b"],
				okfVerified: [{ by: "reviewer", at: "2026-08-19T10:00:00Z" }],
				okfSources: ["https://example.com/spec"],
				okfStaleAfter: "2027-01-01",
			},
		});
		expect(document.frontMatter.tags).toEqual(["a", "b"]);
		expect(document.frontMatter.verified).toEqual([{ by: "reviewer", at: "2026-08-19T10:00:00Z" }]);
		expect(document.frontMatter.sources).toEqual([{ resource: "https://example.com/spec" }]);
		expect(document.frontMatter.stale_after).toBe("2027-01-01");
	});
});

describe("codec round-trip", () => {
	it("preserves content, timestamp, factType, tags, verified, stale_after", () => {
		const original: RawMessage = {
			messageId: "ref-acronym",
			userId: "u-1",
			botId: "okf-import",
			platform: "okf",
			timestamp: Date.parse("2026-08-19T10:00:00Z"),
			content: "OKF = Open Knowledge Format.",
			factType: "world",
			createdAt: Date.parse("2026-08-19T10:00:00Z"),
			metadata: {
				okfGenerator: "test",
				okfTags: ["acronym", "okf"],
				okfVerified: [{ by: "reviewer", at: "2026-08-19T10:00:00Z" }],
				okfStaleAfter: "2027-01-01",
			},
		};
		const { document } = rawMessageToOkf(original);
		const back = okfToRawMessage(
			{ frontMatter: document.frontMatter, body: document.body },
			{ userId: "u-1" },
		);
		expect(back.rawMessage.content).toBe(original.content);
		expect(back.rawMessage.timestamp).toBe(original.timestamp);
		expect(back.rawMessage.factType).toBe(original.factType);
		const meta = back.rawMessage.metadata as Record<string, unknown> | undefined;
		expect(meta?.okfTags).toEqual(original.metadata?.okfTags);
		expect(meta?.okfVerified).toEqual(original.metadata?.okfVerified);
		expect(meta?.okfStaleAfter).toBe(original.metadata?.okfStaleAfter);
	});
});

describe("okfToRawMessage — issue surfacing", () => {
	it("emits a slug_truncated issue when the input exceeds SLUG_MAX_LENGTH", () => {
		const longTitle = "x".repeat(200);
		const result = okfToRawMessage(
			{
				frontMatter: {
					type: "Reference",
					generated: { by: "test", at: "2026-08-19T10:00:00Z" },
				},
				body: longTitle,
			},
			{ userId: "u-1" },
		);
		expect(result.issues.some((i) => i.code === "slug_truncated")).toBe(true);
	});

	it("does not emit slug_truncated for short inputs", () => {
		const result = okfToRawMessage(
			{
				frontMatter: {
					type: "Reference",
					generated: { by: "test", at: "2026-08-19T10:00:00Z" },
				},
				body: "short",
			},
			{ userId: "u-1" },
		);
		expect(result.issues.some((i) => i.code === "slug_truncated")).toBe(false);
	});

	it("falls back to mtimeMs when generated.at is missing", () => {
		const mtime = Date.parse("2025-01-01T00:00:00Z");
		const result = okfToRawMessage(
			{
				frontMatter: {
					type: "Reference",
					generated: { by: "test" },
				},
				body: "hello",
			},
			{ userId: "u-1", mtimeMs: mtime },
		);
		expect(result.rawMessage.timestamp).toBe(mtime);
	});
});

describe("codec round-trip — okfExtras", () => {
	it("preserves an unknown front-matter field through emit → ingest", () => {
		const original: RawMessage = {
			messageId: "reference-foo",
			userId: "u-1",
			botId: "okf-import",
			platform: "okf",
			timestamp: Date.parse("2026-08-19T10:00:00Z"),
			content: "hello world",
			factType: "world",
			createdAt: Date.parse("2026-08-19T10:00:00Z"),
			metadata: {
				okfGenerator: "test",
				// The ingest-side codec nests unknown keys under `okfExtras`,
				// so simulate that on the source side.
				okfExtras: { vendor_provenance: true, custom_field: "hello" },
			},
		};
		const { document } = rawMessageToOkf(original, { packageVersion: "1.0.0" });
		const back = okfToRawMessage(
			{ frontMatter: document.frontMatter, body: document.body },
			{ userId: "u-1" },
		);
		const extras = (back.rawMessage.metadata as Record<string, unknown> | undefined)?.okfExtras as
			| Record<string, unknown>
			| undefined;
		expect(extras?.vendor_provenance).toBe(true);
		expect(extras?.custom_field).toBe("hello");
	});
});

describe("supersedes (inverse link direction)", () => {
	it("keeps `supersedes` off supersededBySummaryId and round-trips as `supersedes`", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				supersedes: "Reference/older-foo",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const ingested = okfToRawMessage(parsed, { userId: "u-1" });
		// The inverse link must NOT land on the forward link field.
		expect(ingested.rawMessage.supersededBySummaryId).toBeUndefined();
		expect((ingested.rawMessage.metadata as Record<string, unknown>).okfSupersedes).toBe(
			"Reference/older-foo",
		);
		// Emitting it back must restore the `supersedes` front-matter key
		// (not `superseded_by`), preserving the original direction.
		const { document } = rawMessageToOkf(ingested.rawMessage);
		expect((document.frontMatter as Record<string, unknown>).supersedes).toBe("Reference/older-foo");
		expect((document.frontMatter as Record<string, unknown>).superseded_by).toBeUndefined();
	});

	it("keeps `superseded_by` on supersededBySummaryId", () => {
		const parsed = {
			frontMatter: {
				type: "Reference",
				superseded_by: "Reference/newer-foo",
				generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			},
			body: "body",
		};
		const ingested = okfToRawMessage(parsed, { userId: "u-1" });
		expect(ingested.rawMessage.supersededBySummaryId).toBe("Reference/newer-foo");
		expect((ingested.rawMessage.metadata as Record<string, unknown>).okfSupersedes).toBeUndefined();
	});
});

describe("OKF_BLOCKING_ISSUE_CODES / isBlockingOkfIssue", () => {
	it("treats structural failures as blocking", () => {
		expect(isBlockingOkfIssue({ code: "missing_type", message: "x" })).toBe(true);
		expect(isBlockingOkfIssue({ code: "missing_generated_at", message: "x" })).toBe(true);
		expect(isBlockingOkfIssue({ code: "empty_body", message: "x" })).toBe(true);
		expect(isBlockingOkfIssue({ code: "invalid_yaml", message: "x" })).toBe(true);
		expect(isBlockingOkfIssue({ code: "invalid_frontmatter", message: "x" })).toBe(true);
	});
	it("treats soft warnings as non-blocking", () => {
		expect(isBlockingOkfIssue({ code: "missing_generated_by", message: "x" })).toBe(false);
		expect(isBlockingOkfIssue({ code: "invalid_stale_after", message: "x" })).toBe(false);
		expect(isBlockingOkfIssue({ code: "unknown_type", message: "x" })).toBe(false);
		expect(isBlockingOkfIssue({ code: "slug_truncated", message: "x" })).toBe(false);
	});
	it("matches the exported blocking set", () => {
		expect(OKF_BLOCKING_ISSUE_CODES).toEqual(
			new Set(["missing_type", "missing_generated_at", "invalid_yaml", "invalid_frontmatter", "empty_body"]),
		);
	});
});

describe("filterRawMessagesByOkfType", () => {
	const rows: RawMessage[] = [
		{
			messageId: "a",
			userId: "u-1",
			botId: "okf-import",
			platform: "okf",
			timestamp: 0,
			content: "x",
			factType: "world",
			metadata: { okfType: "Reference" },
		},
		{
			messageId: "b",
			userId: "u-1",
			botId: "okf-import",
			platform: "okf",
			timestamp: 0,
			content: "y",
			factType: "experience",
			// No okfType metadata — must fall back to factType inverse map.
		},
		{
			messageId: "c",
			userId: "u-1",
			botId: "okf-import",
			platform: "okf",
			timestamp: 0,
			content: "z",
			factType: "mental_model",
			metadata: { okfType: "Opinion" },
		},
	];

	it("returns all rows when types is empty / absent", () => {
		expect(filterRawMessagesByOkfType(rows, null).map((r) => r.messageId)).toEqual(["a", "b", "c"]);
		expect(filterRawMessagesByOkfType(rows, undefined).map((r) => r.messageId)).toEqual(["a", "b", "c"]);
		expect(filterRawMessagesByOkfType(rows, []).map((r) => r.messageId)).toEqual(["a", "b", "c"]);
	});

	it("filters by explicit okfType", () => {
		expect(filterRawMessagesByOkfType(rows, ["Reference"]).map((r) => r.messageId)).toEqual(["a"]);
	});

	it("falls back to the factType inverse map for rows without okfType", () => {
		// Row `b` has no okfType; its factType `experience` → "Experience".
		expect(filterRawMessagesByOkfType(rows, ["Experience"]).map((r) => r.messageId)).toEqual(["b"]);
		// Row `c` has okfType "Opinion" but factType also mental_model → same.
		expect(filterRawMessagesByOkfType(rows, ["Opinion"]).map((r) => r.messageId)).toEqual(["c"]);
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterRawMessagesByOkfType(rows, ["Concept"]).map((r) => r.messageId)).toEqual([]);
	});
});
