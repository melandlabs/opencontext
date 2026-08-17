import { describe, expect, it } from "vitest";
import {
	type InsertRssItem,
	type RssSubscription,
	type RssTagConfig,
	buildRssItemInserts,
	buildTagConfigMetadata,
	extractRssTags,
	parseOpmlFeeds,
} from "./index";

const opml = (body: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>Feeds</title></head><body>${body}</body></opml>`;

describe("parseOpmlFeeds", () => {
	it("extracts feeds from nested outlines and preserves categories", () => {
		const { feeds, skipped, totalFound } = parseOpmlFeeds(
			opml(
				`<outline text="Tech" title="Tech"><outline text="Blog A" title="Blog A" xmlUrl="https://example.com/a.xml"/></outline><outline text="News" title="News" xmlUrl="https://example.com/news.xml" category="News"/>`,
			),
		);
		expect(totalFound).toBe(2);
		expect(feeds).toHaveLength(2);
		expect(feeds[0]).toEqual({ sourceUrl: "https://example.com/a.xml", title: "Blog A", category: "Tech" });
		expect(feeds[1]).toEqual({ sourceUrl: "https://example.com/news.xml", title: "News", category: "News" });
		expect(skipped).toEqual([]);
	});

	it("skips duplicate URLs", () => {
		const { feeds, skipped, totalFound } = parseOpmlFeeds(
			opml(
				`<outline text="A" xmlUrl="https://example.com/feed.xml"/><outline text="B" xmlUrl="https://example.com/feed.xml"/>`,
			),
		);
		expect(totalFound).toBe(2);
		expect(feeds).toHaveLength(1);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.reason).toContain("Duplicate");
	});

	it("strips URL hashes during normalization", () => {
		const { feeds } = parseOpmlFeeds(
			opml(`<outline text="A" xmlUrl="https://example.com/feed.xml#section"/>`),
		);
		expect(feeds[0]?.sourceUrl).toBe("https://example.com/feed.xml");
	});

	it("respects the maxFeeds option", () => {
		const { feeds, skipped, totalFound } = parseOpmlFeeds(
			opml(
				`<outline text="A" xmlUrl="https://example.com/1.xml"/><outline text="B" xmlUrl="https://example.com/2.xml"/>`,
			),
			{ maxFeeds: 1 },
		);
		expect(totalFound).toBe(2);
		expect(feeds).toHaveLength(1);
		expect(skipped[0]?.reason).toContain("Upload limit reached");
	});

	it("skips invalid URLs instead of throwing", () => {
		const { feeds, skipped, totalFound } = parseOpmlFeeds(
			opml(
				`<outline text="Bad protocol" xmlUrl="ftp://example.com/feed.xml"/><outline text="No URL"/><outline text="Good" xmlUrl="https://example.com/feed.xml"/>`,
			),
		);
		expect(totalFound).toBe(2);
		expect(feeds).toHaveLength(1);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.reason).toContain("HTTP/HTTPS");
	});

	it("throws for empty input", () => {
		expect(() => parseOpmlFeeds("")).toThrow("Empty OPML file.");
		expect(() => parseOpmlFeeds("   ")).toThrow("Empty OPML file.");
	});

	it("throws when no outlines are found", () => {
		expect(() => parseOpmlFeeds(opml(""))).toThrow("No outlines were found");
	});

	it("throws when no feed URLs are found", () => {
		expect(() => parseOpmlFeeds(opml(`<outline text="Empty"/>`))).toThrow("No RSS feeds were found");
	});
});

const baseSubscription: RssSubscription = {
	id: "sub-1",
	userId: "user-1",
	sourceUrl: "https://example.com/feed.xml",
	title: "Example Feed",
	category: "News",
	sourceType: "news-feed",
	status: "active",
};

describe("buildRssItemInserts", () => {
	it("maps RSS items to inserts with stable hashes", () => {
		const items = [
			{
				guid: "item-1",
				title: "Hello",
				content: "<p>World</p>",
				isoDate: "2024-01-15T00:00:00.000Z",
				categories: ["Tech"],
				creator: "Alice",
			},
		];
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items, feedTitle: "My Feed" });
		expect(inserts).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by prior check
		const insert = inserts[0]!;
		expect(insert.subscriptionId).toBe("sub-1");
		expect(insert.guidHash).toHaveLength(64);
		expect(insert.title).toBe("Hello");
		expect(insert.content).toBe("<p>World</p>");
		expect(insert.publishedAt?.toISOString()).toBe("2024-01-15T00:00:00.000Z");
		expect(insert.status).toBe("pending");
		expect(insert.metadata.author).toBe("Alice");
		expect(insert.metadata.categories).toEqual(["Tech"]);
		expect(insert.metadata.guid).toBe("item-1");
		expect(insert.metadata.feedTitle).toBe("My Feed");
	});

	it("prefers content:encoded over content", () => {
		const items = [
			{
				guid: "item-2",
				title: "Encoded",
				content: "plain",
				"content:encoded": "<p>encoded</p>",
			},
		];
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items });
		expect(inserts[0]?.content).toBe("<p>encoded</p>");
	});

	it("falls back to an index-based digest when identifiers are missing", () => {
		const items = [{ title: "Untitled" }];
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items });
		expect(inserts[0]?.guidHash).toHaveLength(64);
		expect(inserts[0]?.title).toBe("Untitled");
	});

	it("limits the number of items", () => {
		const items = [{ guid: "1" }, { guid: "2" }, { guid: "3" }];
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items, limit: 2 });
		expect(inserts).toHaveLength(2);
	});

	it("uses a sane default for invalid limits", () => {
		const items = Array.from({ length: 30 }, (_, i) => ({ guid: String(i) }));
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items, limit: -5 });
		expect(inserts).toHaveLength(25);
	});

	it("handles invalid dates by leaving publishedAt null", () => {
		const items = [{ guid: "bad-date", pubDate: "not a date" }];
		const inserts = buildRssItemInserts({ subscription: baseSubscription, items });
		expect(inserts[0]?.publishedAt).toBeNull();
	});

	it("derives the author from creator or author fields", () => {
		const creatorItem = buildRssItemInserts({
			subscription: baseSubscription,
			items: [{ guid: "a", creator: "C" }],
		});
		expect(creatorItem[0]?.metadata.author).toBe("C");

		const authorItem = buildRssItemInserts({
			subscription: baseSubscription,
			items: [{ guid: "b", author: "A" }],
		});
		expect(authorItem[0]?.metadata.author).toBe("A");
	});
});

describe("extractRssTags", () => {
	it("applies source-type defaults when nothing else matches", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Plain",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: { feedTitle: "Generic News" },
		};
		const tags = extractRssTags(item, { ...baseSubscription, sourceType: "news-feed" });
		expect(tags.categories).toContain("News");
		expect(tags.importance).toBe("medium");
		expect(tags.urgency).toBe("not_urgent");
	});

	it("matches keyword rules", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Company raises Series A funding",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: {},
		};
		const tags = extractRssTags(item, { ...baseSubscription, sourceType: "company-blog" });
		expect(tags.categories).toContain("Funding");
		expect(tags.importance).toBe("medium");
	});

	it("applies high importance and 24h urgency for security keywords", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Critical vulnerability patched",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: {},
		};
		const tags = extractRssTags(item, baseSubscription);
		expect(tags.categories).toContain("Security");
		expect(tags.importance).toBe("high");
		expect(tags.urgency).toBe("24h");
	});

	it("maps RSS category metadata to system categories", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Engineering post",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: { categories: ["engineering"] },
		};
		const tags = extractRssTags(item, baseSubscription);
		expect(tags.categories).toContain("R&D");
	});

	it("maps the subscription category to a system category", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Hiring",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: { subscriptionCategory: "Jobs" },
		};
		const tags = extractRssTags(item, { ...baseSubscription, category: "Jobs" });
		expect(tags.categories).toContain("HR & Recruiting");
	});

	it("uses subscription-level tag configuration defaults", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Announcement",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: {},
		};
		const subscription: RssSubscription = {
			...baseSubscription,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			tagConfig: { defaultCategories: ["Branding"], defaultImportance: "low" },
			// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
		} as any;
		const tags = extractRssTags(item, subscription);
		expect(tags.categories).toContain("Branding");
		expect(tags.importance).toBe("low");
	});

	it("adds News to low-importance, non-urgent articles", () => {
		const item: InsertRssItem = {
			subscriptionId: "sub-1",
			guidHash: "hash",
			title: "Minor note",
			summary: null,
			content: null,
			link: null,
			publishedAt: null,
			fetchedAt: new Date(),
			status: "pending",
			metadata: {},
		};
		const subscription: RssSubscription = {
			...baseSubscription,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			tagConfig: { defaultImportance: "low" },
			// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
		} as any;
		const tags = extractRssTags(item, subscription);
		expect(tags.categories).toContain("News");
	});
});

describe("buildTagConfigMetadata", () => {
	it("wraps a tag config in metadata", () => {
		const config: RssTagConfig = {
			defaultCategories: ["Security"],
			defaultImportance: "high",
			defaultUrgency: "24h",
			keywordRules: [{ keywords: ["CVE"], category: "Security", importance: "high" }],
		};
		expect(buildTagConfigMetadata(config)).toEqual({ tagConfig: config });
	});
});
