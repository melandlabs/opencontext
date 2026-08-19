import { describe, expect, it } from "vitest";
import { OkfError } from "./errors.js";
import { parseOkf, parseOkfFrontMatter, stringifyOkf, validateOkfFrontMatter } from "./frontmatter.js";

describe("parseOkf", () => {
	it("parses a well-formed document with front-matter + body", () => {
		const text = `---
type: Reference
title: Hello
---
body line 1
body line 2
`;
		const parsed = parseOkf(text);
		expect(parsed.frontMatter.type).toBe("Reference");
		expect(parsed.frontMatter.title).toBe("Hello");
		expect(parsed.body).toContain("body line 1");
		expect(parsed.body).toContain("body line 2");
	});

	it("preserves unknown front-matter fields", () => {
		const text = `---
type: Reference
unknown_field: keep-me
nested:
  a: 1
  b: [1, 2, 3]
---
body
`;
		const parsed = parseOkf(text);
		expect((parsed.frontMatter as Record<string, unknown>).unknown_field).toBe("keep-me");
		expect((parsed.frontMatter as Record<string, unknown>).nested).toEqual({ a: 1, b: [1, 2, 3] });
	});

	it("treats a document with no front-matter as body only", () => {
		const text = "# Heading\n\nbody\n";
		const parsed = parseOkf(text);
		expect(parsed.frontMatter).toEqual({});
		expect(parsed.body).toBe(text);
	});

	it("tolerates an unterminated front-matter fence", () => {
		const text = "---\ntype: Reference\nno closing fence";
		const parsed = parseOkf(text);
		expect(parsed.frontMatter).toEqual({});
		expect(parsed.body).toBe(text);
	});

	it("throws OkfError on invalid YAML", () => {
		const text = `---
type: Reference
bad: [unclosed
---
body
`;
		expect(() => parseOkf(text)).toThrow(OkfError);
	});
});

describe("parseOkfFrontMatter", () => {
	it("returns a typed front-matter object", () => {
		const fm = parseOkfFrontMatter("type: Reference\ntitle: Hello\n");
		expect(fm.type).toBe("Reference");
		expect(fm.title).toBe("Hello");
	});

	it("rejects unknown enum values for status", () => {
		expect(() => parseOkfFrontMatter("type: Reference\nstatus: bogus\n")).toThrow(OkfError);
	});
});

describe("validateOkfFrontMatter", () => {
	it("returns no issues for a fully-populated document", () => {
		const issues = validateOkfFrontMatter({
			type: "Reference",
			generated: { by: "test", at: "2026-08-19T10:00:00Z" },
		});
		expect(issues).toEqual([]);
	});

	it("flags missing type", () => {
		const issues = validateOkfFrontMatter({});
		expect(issues.some((i) => i.code === "missing_type")).toBe(true);
	});

	it("flags missing generated.at", () => {
		const issues = validateOkfFrontMatter({ type: "Reference" });
		expect(issues.some((i) => i.code === "missing_generated_at")).toBe(true);
	});

	it("flags invalid generated.at format", () => {
		const issues = validateOkfFrontMatter({
			type: "Reference",
			generated: { by: "test", at: "not-a-date" },
		});
		expect(issues.some((i) => i.code === "invalid_generated_at")).toBe(true);
	});

	it("flags invalid stale_after format", () => {
		const issues = validateOkfFrontMatter({
			type: "Reference",
			generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			stale_after: "not-a-date",
		});
		expect(issues.some((i) => i.code === "invalid_stale_after")).toBe(true);
	});

	it("flags stale_after earlier than generated.at", () => {
		const issues = validateOkfFrontMatter({
			type: "Reference",
			generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			stale_after: "2020-01-01",
		});
		expect(issues.some((i) => i.code === "invalid_stale_after")).toBe(true);
	});

	it("accepts a single verified object (not a list)", () => {
		const issues = validateOkfFrontMatter({
			type: "Reference",
			generated: { by: "test", at: "2026-08-19T10:00:00Z" },
			verified: { by: "reviewer", at: "2026-08-19T10:00:00Z" },
		});
		expect(issues).toEqual([]);
	});
});

describe("stringifyOkf", () => {
	it("round-trips a basic document", () => {
		const original = `---
type: Reference
title: Hello
---
body
`;
		const parsed = parseOkf(original);
		const back = stringifyOkf(parsed);
		const reparsed = parseOkf(back);
		expect(reparsed.frontMatter).toEqual(parsed.frontMatter);
		// The body has a trailing newline; the codec strips leading
		// newlines but preserves trailing ones, so the round-trip
		// matches the body modulo the leading newline.
		expect(reparsed.body.replace(/^\n+/, "")).toBe(parsed.body.replace(/^\n+/, ""));
	});

	it("emits a leading fence with no trailing body newline", () => {
		const out = stringifyOkf({ frontMatter: { type: "Reference" }, body: "" });
		expect(out).toMatch(/^---\n/);
		expect(out).toMatch(/---\n?$/);
	});
});

describe("parseOkf — CRLF", () => {
	it("parses a CRLF document the same as LF", () => {
		const text =
			"---\r\ntype: Reference\r\ngenerated: { by: t, at: '2026-08-19T10:00:00Z' }\r\n---\r\nbody\r\n";
		const crlf = parseOkf(text);
		expect(crlf.frontMatter.type).toBe("Reference");
		// The body retains the leading newline after the closing fence,
		// and only the `\r` separators are normalised away — matches the
		// behaviour documented in `frontmatter.ts` for LF inputs.
		expect(crlf.body.replace(/\r/g, "")).toBe("\nbody\n");
	});
});
