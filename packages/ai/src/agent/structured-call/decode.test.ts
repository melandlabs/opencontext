import { describe, expect, it, vi } from "vitest";

import { extractToolUseInput, findShapedObject } from "./decode";

const PLAN_KEYS = ["summary", "actions"] as const;

describe("findShapedObject", () => {
	it("returns the input when it already matches at the top level", () => {
		const shape = { summary: "s", actions: [1, 2] };
		expect(findShapedObject(shape, PLAN_KEYS)).toBe(shape);
	});

	it("unwraps the default wrapper keys", () => {
		for (const key of ["plan", "response", "output", "result", "data", "payload"]) {
			const shape = { summary: "s", actions: [] };
			expect(findShapedObject({ [key]: { noise: 1, [key]: shape } }, PLAN_KEYS)).toEqual(shape);
		}
	});

	it("descends through arbitrary keys when no wrapper key matches", () => {
		const shape = { summary: "s", actions: [] };
		expect(findShapedObject({ envelope: { nested: shape } }, PLAN_KEYS)).toEqual(shape);
	});

	it("prefers wrapper keys over earlier generic values", () => {
		const input = {
			zFirst: { summary: "generic", actions: [] },
			plan: { summary: "canonical", actions: [] },
		};
		expect(findShapedObject(input, PLAN_KEYS)).toEqual({ summary: "canonical", actions: [] });
	});

	it("does not descend into arrays (matches the planner semantics it generalizes)", () => {
		const shape = { summary: "s", actions: [] };
		expect(findShapedObject([shape], PLAN_KEYS)).toBeNull();
		expect(findShapedObject({ items: [0, shape] }, PLAN_KEYS)).toBeNull();
	});

	it("returns null beyond maxDepth", () => {
		const shape = { summary: "s", actions: [] };
		const fourDeep = { a: { b: { c: { d: shape } } } };
		const fiveDeep = { a: { b: { c: { d: { e: shape } } } } };
		expect(findShapedObject(fourDeep, PLAN_KEYS)).toEqual(shape);
		expect(findShapedObject(fiveDeep, PLAN_KEYS)).toBeNull();
		expect(findShapedObject(fiveDeep, PLAN_KEYS, { maxDepth: 5 })).toEqual(shape);
	});

	it("honors a custom wrapperKeys list", () => {
		const shape = { summary: "s", actions: [] };
		expect(findShapedObject({ data: { plan: shape } }, PLAN_KEYS, { wrapperKeys: ["plan"] })).toEqual(shape);
	});

	it("requires every key to be present", () => {
		expect(findShapedObject({ summary: "s" }, PLAN_KEYS)).toBeNull();
		expect(findShapedObject({ actions: [] }, PLAN_KEYS)).toBeNull();
	});

	it("rejects non-object roots", () => {
		expect(findShapedObject(null, PLAN_KEYS)).toBeNull();
		expect(findShapedObject("nope", PLAN_KEYS)).toBeNull();
		expect(findShapedObject([1, 2], PLAN_KEYS)).toBeNull();
	});

	it("applies the matches predicate on top of key presence", () => {
		const wrongTypes = { summary: 42, actions: "not-an-array" };
		expect(findShapedObject(wrongTypes, PLAN_KEYS)).toEqual(wrongTypes);
		expect(
			findShapedObject(wrongTypes, PLAN_KEYS, {
				matches: (record) => typeof record.summary === "string" && Array.isArray(record.actions),
			}),
		).toBeNull();
	});
});

describe("extractToolUseInput", () => {
	it("returns the input of a single matching tool_use block", () => {
		const content = [
			{ type: "text", text: "thinking..." },
			{ type: "tool_use", id: "1", name: "submit_plan", input: { summary: "s" } },
		];
		const result = extractToolUseInput(content, { toolName: "submit_plan" });
		expect(result).toEqual({ input: { summary: "s" }, source: "tool_use" });
	});

	it("takes the first of multiple tool_use blocks and warns", () => {
		const onWarn = vi.fn();
		const content = [
			{ type: "tool_use", id: "1", name: "submit_plan", input: { first: true } },
			{ type: "tool_use", id: "2", name: "submit_plan", input: { second: true } },
		];
		const result = extractToolUseInput(content, { toolName: "submit_plan", onWarn });
		expect(result).toEqual({ input: { first: true }, source: "tool_use" });
		expect(onWarn).toHaveBeenCalledTimes(1);
		expect(onWarn.mock.calls[0][0]).toContain("multiple");
	});

	it("falls back to embedded JSON in text blocks when no tool_use matches", () => {
		const content = [{ type: "text", text: 'here is the plan: {"summary":"s","actions":[]}' }];
		const result = extractToolUseInput(content, { toolName: "submit_plan" });
		expect(result).toEqual({
			input: { summary: "s", actions: [] },
			source: "text_json_fallback",
		});
	});

	it("keeps scanning subsequent text blocks after unparseable ones", () => {
		const content = [
			{ type: "text", text: "reasoning without json" },
			{ type: "text", text: 'blah {"summary":"s","actions":[1]} trailing' },
		];
		const result = extractToolUseInput(content, { toolName: "submit_plan" });
		expect(result).toEqual({
			input: { summary: "s", actions: [1] },
			source: "text_json_fallback",
		});
	});

	it("skips balanced-but-invalid JSON and continues", () => {
		const content = [
			{ type: "text", text: '{"summary": NaN}' },
			{ type: "text", text: 'unbalanced {"a":1' },
			{ type: "text", text: '{"summary":"s"}' },
		];
		const result = extractToolUseInput(content, { toolName: "submit_plan" });
		expect(result).toEqual({ input: { summary: "s" }, source: "text_json_fallback" });
	});

	it("ignores tool_use blocks under a different name", () => {
		const content = [
			{ type: "tool_use", id: "1", name: "other_tool", input: { nope: true } },
			{ type: "text", text: '{"summary":"s"}' },
		];
		const result = extractToolUseInput(content, { toolName: "submit_plan" });
		expect(result?.source).toBe("text_json_fallback");
	});

	it("returns null and warns when nothing is recoverable", () => {
		const onWarn = vi.fn();
		const content = [
			{ type: "text", text: "no json at all" },
			{ type: "tool_use", id: "1", name: "other_tool", input: {} },
		];
		expect(extractToolUseInput(content, { toolName: "submit_plan", onWarn })).toBeNull();
		expect(onWarn).toHaveBeenCalledTimes(1);
		expect(onWarn.mock.calls[0][0]).toContain("submit_plan");
	});

	it("reports block types of unknown blocks in the warning", () => {
		const onWarn = vi.fn();
		const content = [{ type: "thinking" }, "not-a-block"];
		extractToolUseInput(content, { toolName: "submit_plan", onWarn });
		expect(onWarn.mock.calls[0][0]).toContain("thinking");
		expect(onWarn.mock.calls[0][0]).toContain("unknown");
	});
});
