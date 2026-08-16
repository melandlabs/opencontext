/**
 * @melandlabs/opencontext — facade re-export contract.
 *
 * The facade is the "install one package, get the whole substrate"
 * entry point. It re-exports from five workspace packages (contracts,
 * memory-store, rag, loop, ai). This file pins the public symbols a
 * downstream consumer is allowed to import, and exercises a few of the
 * underlying functions to confirm the bundle resolves end-to-end under
 * vitest (not just at install time).
 *
 * If a symbol disappears, a re-export name changes, or a transitive
 * dep stops loading, this file fails loudly instead of leaving the
 * breakage to a downstream host app.
 */

import { describe, expect, it } from "vitest";

import * as facade from "./index";

describe("@melandlabs/opencontext facade", () => {
	it("re-exports the contracts package boundary guards", () => {
		expect(typeof facade.isUserType).toBe("function");
		expect(typeof facade.isIntegrationId).toBe("function");
		expect(facade.isUserType("pro")).toBe(true);
		expect(facade.isUserType("not-a-user-type")).toBe(false);
		expect(Array.isArray(facade.USER_TYPES)).toBe(true);
		expect(facade.USER_TYPES.length).toBeGreaterThanOrEqual(5);
	});

	it("re-exports chunkText with the rag signature (maxChunkSize, not chunkSize)", () => {
		expect(typeof facade.chunkText).toBe("function");
		const out = facade.chunkText("a. b. c. d. e.", { maxChunkSize: 4 });
		expect(Array.isArray(out)).toBe(true);
		// Every returned chunk has the documented shape; positions are
		// cumulative (startPosition === sum of previous chunk lengths).
		for (const c of out) {
			expect(typeof c.content).toBe("string");
			expect(typeof c.startPosition).toBe("number");
			expect(typeof c.endPosition).toBe("number");
			expect(c.endPosition).toBeGreaterThanOrEqual(c.startPosition);
		}
	});

	it("re-exports the unified-search entry points", () => {
		expect(typeof facade.createMemoryStore).toBe("function");
		expect(typeof facade.createUnifiedSearch).toBe("function");
		expect(typeof facade.createRawMessageStore).toBe("function");
		expect(typeof facade.getRawMessageManager).toBe("function");
		expect(typeof facade.registerPostgresFactory).toBe("function");
	});

	it("re-exports rag helpers that a host app would reach for at startup", () => {
		expect(typeof facade.countTokens).toBe("function");
		expect(typeof facade.cosineSimilarity).toBe("function");
		expect(typeof facade.getOptimalChunkSize).toBe("function");
		expect(typeof facade.estimateChunkCount).toBe("function");

		// countTokens is non-negative and monotone: longer text ≥ shorter text
		const short = facade.countTokens("hi");
		const long = facade.countTokens("hi ".repeat(200));
		expect(short).toBeGreaterThanOrEqual(0);
		expect(long).toBeGreaterThan(short);
	});

	it("re-exports loop filesystem primitives (constants only — no disk I/O)", () => {
		expect(typeof facade.LOOP_PATHS).toBe("object");
		expect(typeof facade.LOOP_PATHS.home).toBe("string");
		expect(facade.LOOP_PATHS.home).toContain(".opencontext");
		expect(typeof facade.ensureDirs).toBe("function");
	});

	it("re-exports ai package primitives (helpers + pricing table)", () => {
		expect(typeof facade.estimateTokens).toBe("function");
		expect(typeof facade.getModelPricing).toBe("function");
		expect(typeof facade.MODEL_PRICING).toBe("object");
		// estimateTokens is monotone: longer text ≥ shorter text.
		expect(facade.estimateTokens("hi ".repeat(200))).toBeGreaterThan(facade.estimateTokens("hi"));
	});

	it("re-exports security and integrations/core packages through the facade", () => {
		// The facade now exposes token encryption / SSRF protection and the
		// minimal integration context factory so a host app can get started
		// with only `@melandlabs/opencontext`. Other integrations utilities
		// (e.g. text cleaners) are still not re-exported to keep the bundle
		// focused.
		expect(typeof (facade as Record<string, unknown>).TokenEncryption).toBe("function");
		expect(typeof (facade as Record<string, unknown>).validateUrlForSSRF).toBe("function");
		expect(typeof (facade as Record<string, unknown>).createMinimalContext).toBe("function");
		expect((facade as Record<string, unknown>).htmlToPlainText).toBeUndefined();
	});

	it("does not pollute the global namespace with conflicting UserType exports", () => {
		// @melandlabs/ai re-exports UserType, contracts has its own UserType.
		// The facade uses contracts' canonical UserType and renames ai's to
		// AIUserType to avoid duplicate-type conflicts in compiled bundles.
		// If that discipline regresses, this test catches it.
		// `AIUserType` is a type-only re-export, so it must have no runtime
		// binding on the namespace object. Read through an index signature —
		// the property intentionally doesn't exist on the typed surface.
		expect((facade as Record<string, unknown>).AIUserType).toBeUndefined();
	});
});
