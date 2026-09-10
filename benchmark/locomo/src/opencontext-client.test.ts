import { describe, expect, it, vi } from "vitest";

import { AnswererGenerationError, retryAnswererOperation } from "./opencontext-client";

describe("retryAnswererOperation", () => {
	it("retries transient failures and reports the successful attempt", async () => {
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("timeout"))
			.mockRejectedValueOnce(new Error("provider error"))
			.mockResolvedValueOnce("answer");
		const wait = vi.fn(async () => undefined);

		await expect(retryAnswererOperation(operation, 3, wait)).resolves.toEqual({
			result: "answer",
			attempt: 3,
		});
		expect(operation).toHaveBeenCalledTimes(3);
		expect(wait).toHaveBeenNthCalledWith(1, 1000);
		expect(wait).toHaveBeenNthCalledWith(2, 2000);
	});

	it("reports the attempt count after exhausting retries", async () => {
		const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("timeout"));
		const error = await retryAnswererOperation(operation, 3, async () => undefined).catch((caught) => caught);

		expect(error).toBeInstanceOf(AnswererGenerationError);
		expect(error).toMatchObject({ attempts: 3 });
		expect(error.message).toContain("Last error: timeout");
	});
});
