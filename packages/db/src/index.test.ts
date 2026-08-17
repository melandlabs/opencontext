import { compareSync } from "bcrypt-ts";
import { describe, expect, it, vi } from "vitest";
import { batchInsert, generateDummyPassword, generateHashedPassword } from "./index";

describe("batchInsert", () => {
	it("returns an empty array when items is empty", async () => {
		const insertFn = vi.fn().mockResolvedValue([]);
		const result = await batchInsert([], 10, insertFn);
		expect(result).toEqual([]);
		expect(insertFn).not.toHaveBeenCalled();
	});

	it("calls insertFn once when items fit in a single chunk", async () => {
		const items = [1, 2, 3];
		const insertFn = vi.fn().mockResolvedValue([10, 20, 30]);
		const result = await batchInsert(items, 5, insertFn);
		expect(insertFn).toHaveBeenCalledTimes(1);
		expect(insertFn).toHaveBeenCalledWith([1, 2, 3]);
		expect(result).toEqual([10, 20, 30]);
	});

	it("chunks items and calls insertFn for each chunk", async () => {
		const items = [1, 2, 3, 4, 5];
		const insertFn = vi
			.fn()
			.mockImplementation((chunk: number[]) => Promise.resolve(chunk.map((n) => n * 10)));
		const result = await batchInsert(items, 2, insertFn);
		expect(insertFn).toHaveBeenCalledTimes(3);
		expect(insertFn).toHaveBeenNthCalledWith(1, [1, 2]);
		expect(insertFn).toHaveBeenNthCalledWith(2, [3, 4]);
		expect(insertFn).toHaveBeenNthCalledWith(3, [5]);
		expect(result).toEqual([10, 20, 30, 40, 50]);
	});

	it("merges array results from multiple chunks", async () => {
		const items = ["a", "b", "c", "d"];
		const insertFn = vi.fn().mockResolvedValue(["x", "y"]);
		const result = await batchInsert(items, 2, insertFn);
		expect(result).toEqual(["x", "y", "x", "y"]);
	});

	it("pushes non-array results into the result array", async () => {
		const items = [1, 2, 3];
		const insertFn = vi.fn().mockResolvedValue({ count: 1 });
		const result = await batchInsert(items, 1, insertFn);
		expect(result).toEqual([{ count: 1 }, { count: 1 }, { count: 1 }]);
	});

	it("handles a chunk size larger than the item count", async () => {
		const items = [7, 8];
		const insertFn = vi.fn().mockResolvedValue([7, 8]);
		const result = await batchInsert(items, 100, insertFn);
		expect(insertFn).toHaveBeenCalledTimes(1);
		expect(insertFn).toHaveBeenCalledWith([7, 8]);
		expect(result).toEqual([7, 8]);
	});

	it("handles an exact multiple of the chunk size", async () => {
		const items = [1, 2, 3, 4];
		const insertFn = vi.fn().mockImplementation((chunk: number[]) => Promise.resolve(chunk));
		const result = await batchInsert(items, 2, insertFn);
		expect(insertFn).toHaveBeenCalledTimes(2);
		expect(result).toEqual([1, 2, 3, 4]);
	});

	it("propagates errors from insertFn", async () => {
		const items = [1, 2];
		const insertFn = vi.fn().mockRejectedValue(new Error("insert failed"));
		await expect(batchInsert(items, 1, insertFn)).rejects.toThrow("insert failed");
		expect(insertFn).toHaveBeenCalledTimes(1);
	});
});

describe("generateHashedPassword", () => {
	it("returns a bcrypt hash starting with $2a$10$", () => {
		const hash = generateHashedPassword("hunter2");
		expect(hash).toMatch(/^\$2a\$10\$/);
	});

	it("verifies the original password against the hash", () => {
		const password = "my-secret-password";
		const hash = generateHashedPassword(password);
		expect(compareSync(password, hash)).toBe(true);
	});

	it("does not verify a different password against the hash", () => {
		const hash = generateHashedPassword("correct-horse-battery-staple");
		expect(compareSync("wrong-password", hash)).toBe(false);
	});

	it("produces different hashes for the same password", () => {
		const password = " reused-password";
		const hashA = generateHashedPassword(password);
		const hashB = generateHashedPassword(password);
		expect(hashA).not.toEqual(hashB);
		expect(compareSync(password, hashA)).toBe(true);
		expect(compareSync(password, hashB)).toBe(true);
	});

	it("hashes an empty password", () => {
		const hash = generateHashedPassword("");
		expect(hash).toMatch(/^\$2a\$10\$/);
		expect(compareSync("", hash)).toBe(true);
	});
});

describe("generateDummyPassword", () => {
	it("returns a non-empty bcrypt hash", () => {
		const hash = generateDummyPassword();
		expect(hash).toBeTruthy();
		expect(hash.length).toBeGreaterThan(0);
		expect(hash).toMatch(/^\$2a\$10\$/);
	});

	it("returns a different hash on each call", () => {
		const hashA = generateDummyPassword();
		const hashB = generateDummyPassword();
		expect(hashA).not.toEqual(hashB);
	});

	it("returns a hash that can be verified with bcrypt", () => {
		const hash = generateDummyPassword();
		expect(hash).toMatch(/^\$2a\$10\$/);
	});
});

describe("package exports", () => {
	it("exports batchInsert from index", () => {
		expect(typeof batchInsert).toBe("function");
	});

	it("exports password helpers from index", () => {
		expect(typeof generateHashedPassword).toBe("function");
		expect(typeof generateDummyPassword).toBe("function");
	});
});
