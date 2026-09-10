import { describe, expect, it } from "vitest";

import { CATEGORY_NAMES, getCategoryName } from "./scorer";

describe("LoCoMo category mapping", () => {
	it("uses the dataset's published category ids", () => {
		expect(CATEGORY_NAMES).toEqual({
			"1": "multi_hop",
			"2": "temporal",
			"3": "open_domain",
			"4": "single_hop",
			"5": "adversarial",
		});
		expect(getCategoryName(9)).toBe("category_9");
	});
});
