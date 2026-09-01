import { describe, expect, it } from "vitest";

import { extractBalancedJsonObject } from "./json";

describe("extractBalancedJsonObject", () => {
	it("extracts a flat object", () => {
		expect(extractBalancedJsonObject('{"a":1}')).toBe('{"a":1}');
	});

	it("extracts the first balanced object when several are present", () => {
		expect(extractBalancedJsonObject('{"a":1} then {"b":2}')).toBe('{"a":1}');
	});

	it("extracts nested objects", () => {
		const raw = '{"outer":{"inner":{"list":[1,2,{"deep":true}]}},"tail":"x"}';
		expect(extractBalancedJsonObject(raw)).toBe(raw);
	});

	it("ignores braces inside string literals", () => {
		const raw = '{"text":"}{ { not code }{"}';
		expect(extractBalancedJsonObject(raw)).toBe(raw);
	});

	it("handles escaped quotes inside strings", () => {
		const raw = '{"quote":"he said \\"hi {there}\\" ok"}';
		expect(extractBalancedJsonObject(raw)).toBe(raw);
	});

	it("skips leading prose before the first brace", () => {
		expect(extractBalancedJsonObject('Here is the plan: {"a":1}')).toBe('{"a":1}');
	});

	it("returns null when there is no opening brace", () => {
		expect(extractBalancedJsonObject("no json here")).toBeNull();
	});

	it("returns null for an unterminated object", () => {
		expect(extractBalancedJsonObject('{"a":{"b":1}')).toBeNull();
	});

	it("returns null when a string literal is left open", () => {
		expect(extractBalancedJsonObject('{"a":"unterminated}')).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(extractBalancedJsonObject("")).toBeNull();
	});

	it("does not count braces in an unterminated string as closers", () => {
		// The } inside the string must not close the object early; the object
		// only closes on the real final brace.
		const raw = '{"s":"}","n":2}';
		expect(extractBalancedJsonObject(raw)).toBe(raw);
	});
});
