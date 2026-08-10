/**
 * Brave Search API Service
 *
 * Provides web search and news search functionality using Brave Search API.
 * API Reference: https://brave.com/search/api/
 */

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
  news?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_NEWS_API_URL = "https://api.search.brave.com/res/v1/news/search";

export type SearchType = "web" | "news";

/**
 * Get the Brave Search API key from environment
 */
function getApiKey(): string {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured");
  }
  return apiKey;
}

/**
 * Perform a search using Brave Search API (web or news)
 *
 * @param query - Search query string
 * @param type - Search type: "web" (default) or "news"
 * @param count - Number of results to return (default: 10, max: 20)
 */
export async function search(
  query: string,
  type: SearchType = "web",
  count = 10,
): Promise<SearchResult[]> {
  const apiKey = getApiKey();
  const safeCount = Math.min(count, 20);
  const baseUrl = type === "news" ? BRAVE_NEWS_API_URL : BRAVE_SEARCH_API_URL;
  const url = new URL(baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", safeCount.toString());

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Brave ${type}] API error:`, response.status, errorText);
    throw new Error(`Brave Search API error: ${response.status}`);
  }

  const data: BraveSearchResponse = await response.json();

  if (type === "news") {
    const results = data.news?.results || [];
    return results
      .filter((r) => r.title && r.url)
      .map((r) => ({
        title: r.title || "",
        url: r.url || "",
        description: r.description || "",
      }));
  }

  const results = data.web?.results || [];
  return results
    .filter((r) => r.title && r.url)
    .map((r) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.description || "",
    }));
}
