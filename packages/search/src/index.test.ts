import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SearchResult, needsRealTimeInfo, search } from "./index";

describe("search", () => {
	describe("needsRealTimeInfo", () => {
		it("returns false for empty or non-string input", () => {
			expect(needsRealTimeInfo("")).toBe(false);
			expect(needsRealTimeInfo(null as unknown as string)).toBe(false);
			expect(needsRealTimeInfo(undefined as unknown as string)).toBe(false);
		});

		it("detects weather queries", () => {
			expect(needsRealTimeInfo("What is the weather today?")).toBe(true);
			expect(needsRealTimeInfo("weather in Tokyo")).toBe(true);
			expect(needsRealTimeInfo("How is the weather?")).toBe(true);
		});

		it("detects news queries", () => {
			expect(needsRealTimeInfo("latest news on AI")).toBe(true);
			expect(needsRealTimeInfo("breaking news")).toBe(true);
			expect(needsRealTimeInfo("any updates on the election?")).toBe(true);
		});

		it("detects stock and price queries", () => {
			expect(needsRealTimeInfo("AAPL stock price")).toBe(true);
			expect(needsRealTimeInfo("current stock market")).toBe(true);
			expect(needsRealTimeInfo("bitcoin price")).toBe(true);
			expect(needsRealTimeInfo("currency rate USD to EUR")).toBe(true);
		});

		it("detects time-sensitive factual queries", () => {
			expect(needsRealTimeInfo("What happened yesterday?")).toBe(true);
			expect(needsRealTimeInfo("What's happening now?")).toBe(true);
			expect(needsRealTimeInfo("top movies this week")).toBe(true);
			expect(needsRealTimeInfo("current president")).toBe(true);
		});

		it("detects version/release queries", () => {
			expect(needsRealTimeInfo("latest release of Node.js")).toBe(true);
			expect(needsRealTimeInfo("new version of React")).toBe(true);
		});

		it("returns false for static factual queries", () => {
			expect(needsRealTimeInfo("What is the capital of France?")).toBe(false);
			expect(needsRealTimeInfo("Explain quantum computing")).toBe(false);
			expect(needsRealTimeInfo("How does photosynthesis work?")).toBe(false);
			expect(needsRealTimeInfo("Translate hello to Japanese")).toBe(false);
		});
	});

	describe("search", () => {
		const originalFetch = globalThis.fetch;
		const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;

		beforeEach(() => {
			process.env.BRAVE_SEARCH_API_KEY = "test-api-key";
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
			if (originalApiKey === undefined) {
				Reflect.deleteProperty(process.env, "BRAVE_SEARCH_API_KEY");
			} else {
				process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
			}
			vi.restoreAllMocks();
		});

		it("throws when BRAVE_SEARCH_API_KEY is missing", async () => {
			Reflect.deleteProperty(process.env, "BRAVE_SEARCH_API_KEY");
			await expect(search("test")).rejects.toThrow("BRAVE_SEARCH_API_KEY is not configured");
		});

		it("returns web search results from a mocked fetch response", async () => {
			const mockResults: SearchResult[] = [
				{
					title: "Brave Search",
					url: "https://search.brave.com",
					description: "Privacy-focused search engine",
				},
			];

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					web: {
						results: mockResults,
					},
				}),
			});

			const results = await search("brave search");

			expect(results).toEqual(mockResults);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);

			const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(callUrl).toContain("https://api.search.brave.com/res/v1/web/search");
			expect(callUrl).toContain("q=brave+search");
			expect(callUrl).toContain("count=10");
		});

		it("returns news search results from a mocked fetch response", async () => {
			const mockResults: SearchResult[] = [
				{
					title: "Breaking News",
					url: "https://example.com/news",
					description: "Latest headlines",
				},
			];

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					news: {
						results: mockResults,
					},
				}),
			});

			const results = await search("headlines", "news");

			expect(results).toEqual(mockResults);

			const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(callUrl).toContain("https://api.search.brave.com/res/v1/news/search");
		});

		it("filters out results missing title or url", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					web: {
						results: [
							{ title: "Valid", url: "https://valid.test", description: "ok" },
							{ title: "Missing URL", description: "skip" },
							{ url: "https://missing-title.test", description: "skip" },
							{ description: "skip both" },
						],
					},
				}),
			});

			const results = await search("query");

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				title: "Valid",
				url: "https://valid.test",
				description: "ok",
			});
		});

		it("clamps count to a maximum of 20", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ web: { results: [] } }),
			});

			await search("query", "web", 100);

			const callUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(callUrl).toContain("count=20");
		});

		it("throws when the API returns a non-ok response", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 429,
				text: async () => "Rate limited",
			});

			await expect(search("query")).rejects.toThrow("Brave Search API error: 429");
		});

		it("sends the correct Authorization header", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ web: { results: [] } }),
			});

			await search("query");

			const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
			expect(callArgs.headers).toMatchObject({
				Accept: "application/json",
				"X-Subscription-Token": "test-api-key",
			});
		});
	});
});
