/**
 * Category names mapping for LoCoMo benchmark.
 */

export const CATEGORY_NAMES: Record<string, string> = {
	"1": "multi_hop",
	"2": "temporal",
	"3": "open_domain",
	"4": "single_hop",
	"5": "adversarial", // Usually excluded from overall stats
};

export const CATEGORIES = ["multi_hop", "temporal", "open_domain", "single_hop"];

export function getCategoryName(category: number): string {
	return CATEGORY_NAMES[String(category)] ?? `category_${category}`;
}
