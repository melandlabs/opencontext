/**
 * Tests for lib-mode insights backend methods.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLibBackend } from "../src/backend-lib.js";
import { makeConfig } from "./_helpers.js";

describe("lib backend insights", () => {
	let tmpDir: string;
	let config: ReturnType<typeof makeConfig>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dsh-insights-"));
		config = makeConfig({ scopeId: "scope-1", timeoutMs: 5000 });
		process.env.MEMORY_STORE_DB_PATH = join(tmpDir, "memory.db");
	});

	afterEach(() => {
		process.env.MEMORY_STORE_DB_PATH = undefined;
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("captures and searches insights", async () => {
		const backend = createLibBackend(config);

		const capture = await backend.captureInsight!({
			content: "User prefers TypeScript for all new services",
			category: "preference",
			metadata: { project: "auth" },
			scopeId: "scope-1",
			userId: "user-1",
		});

		expect(capture.id).toBeTruthy();

		const search = await backend.searchInsights!({
			query: "TypeScript preference",
			limit: 10,
			threshold: 0,
			scopeId: "scope-1",
			userId: "user-1",
		});

		expect(search.insights.length).toBeGreaterThan(0);
		expect(search.insights[0]?.content).toContain("TypeScript");
		expect(search.insights[0]?.category).toBe("preference");
	});

	it("filters insights by category", async () => {
		const backend = createLibBackend(config);

		await backend.captureInsight!({
			content: "Use PostgreSQL for the main store",
			category: "decision",
			scopeId: "scope-1",
			userId: "user-1",
		});

		await backend.captureInsight!({
			content: "User likes dark mode",
			category: "preference",
			scopeId: "scope-1",
			userId: "user-1",
		});

		const search = await backend.searchInsights!({
			query: "dark",
			categories: ["preference"],
			limit: 10,
			threshold: 0,
			scopeId: "scope-1",
			userId: "user-1",
		});

		expect(search.insights.length).toBe(1);
		expect(search.insights[0]?.category).toBe("preference");
	});

	it("isolates insights by scope/user", async () => {
		const backend = createLibBackend(config);

		await backend.captureInsight!({
			content: "Secret plan",
			category: "plan",
			scopeId: "scope-a",
			userId: "user-a",
		});

		const search = await backend.searchInsights!({
			query: "secret",
			limit: 10,
			threshold: 0,
			scopeId: "scope-b",
			userId: "user-b",
		});

		expect(search.insights).toHaveLength(0);
	});
});
