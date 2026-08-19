import { describe, expect, it } from "vitest";
import { autoScopeId, resolveScopeId } from "../src/scope.js";

describe("autoScopeId", () => {
	it("hashes a cwd into local:<12hex>", () => {
		const a = autoScopeId("/Users/developer/projects/foo");
		const b = autoScopeId("/Users/developer/projects/foo");
		const c = autoScopeId("/Users/developer/projects/bar");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^local:[0-9a-f]{12}$/);
	});

	it("returns the default for empty input", () => {
		expect(autoScopeId("")).toBe("local:default");
	});
});

describe("resolveScopeId", () => {
	it("prefers the configured scope", () => {
		expect(resolveScopeId("team:alpha", "/Users/developer/projects/foo")).toBe("team:alpha");
	});

	it("falls back to auto-detection when not configured", () => {
		const out = resolveScopeId("", "/Users/developer/projects/foo");
		expect(out).toMatch(/^local:[0-9a-f]{12}$/);
	});
});
