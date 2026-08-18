import { describe, expect, it } from "vitest";
import {
	computeNextRun,
	createJobExecutionStreamResponse,
	formatDate,
	isJobDue,
	parseDate,
	validateCronExpression,
} from "./index";
import type { JobAgentStreamEvent, ScheduleConfig } from "./index";

const EPOCH = new Date("2024-01-01T00:00:00.000Z");

describe("computeNextRun", () => {
	describe('type "once"', () => {
		it("returns the Date when it is in the future", () => {
			const future = new Date(EPOCH.getTime() + 60_000);
			const result = computeNextRun({ type: "once", at: future }, EPOCH);
			expect(result).toEqual(future);
		});

		it("parses an ISO string and returns the future date", () => {
			const result = computeNextRun({ type: "once", at: "2024-01-01T00:01:00.000Z" }, EPOCH);
			expect(result?.toISOString()).toBe("2024-01-01T00:01:00.000Z");
		});

		it("returns null when the date is in the past", () => {
			const past = new Date(EPOCH.getTime() - 1);
			expect(computeNextRun({ type: "once", at: past }, EPOCH)).toBeNull();
		});

		it("returns null when the date equals now", () => {
			expect(computeNextRun({ type: "once", at: EPOCH }, EPOCH)).toBeNull();
		});

		it("returns null for an invalid date string", () => {
			expect(computeNextRun({ type: "once", at: "not a date" }, EPOCH)).toBeNull();
		});
	});

	describe('type "interval-hours"', () => {
		it("adds the configured hours to now", () => {
			const result = computeNextRun({ type: "interval-hours", hours: 2 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 2 * 60 * 60 * 1000);
		});

		it("defaults to one hour when hours is missing", () => {
			const config = { type: "interval-hours", hours: undefined } as unknown as ScheduleConfig;
			const result = computeNextRun(config, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 60 * 60 * 1000);
		});
	});

	describe('type "interval-minutes"', () => {
		it("adds the configured minutes to now", () => {
			const result = computeNextRun({ type: "interval-minutes", minutes: 30 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 30 * 60 * 1000);
		});

		it("defaults to sixty minutes when minutes is missing", () => {
			const config = { type: "interval-minutes", minutes: undefined } as unknown as ScheduleConfig;
			const result = computeNextRun(config, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 60 * 60 * 1000);
		});
	});

	describe('type "interval"', () => {
		it("adds hours and minutes together", () => {
			const result = computeNextRun({ type: "interval", hours: 1, minutes: 30 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 90 * 60 * 1000);
		});

		it("uses only hours when minutes are omitted", () => {
			const result = computeNextRun({ type: "interval", hours: 2 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 2 * 60 * 60 * 1000);
		});

		it("uses only minutes when hours are omitted", () => {
			const result = computeNextRun({ type: "interval", minutes: 15 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 15 * 60 * 1000);
		});

		it("defaults to sixty minutes when both are zero", () => {
			const result = computeNextRun({ type: "interval", hours: 0, minutes: 0 }, EPOCH);
			expect(result?.getTime()).toBe(EPOCH.getTime() + 60 * 60 * 1000);
		});
	});

	describe('type "cron"', () => {
		it("computes the next run from a cron expression", () => {
			const result = computeNextRun({ type: "cron", expression: "0 9 * * *", timezone: "UTC" }, EPOCH);
			expect(result).not.toBeNull();
			expect(result?.toISOString()).toBe("2024-01-01T09:00:00.000Z");
		});

		it("respects the supplied timezone", () => {
			const result = computeNextRun(
				{ type: "cron", expression: "0 0 * * *", timezone: "America/New_York" },
				EPOCH,
			);
			// 2024-01-01 00:00 EST is 05:00 UTC
			expect(result?.toISOString()).toBe("2024-01-01T05:00:00.000Z");
		});

		it("returns null for an invalid cron expression", () => {
			expect(computeNextRun({ type: "cron", expression: "not valid" }, EPOCH)).toBeNull();
		});
	});

	it("returns null for an unknown schedule type", () => {
		const config = { type: "unknown" } as unknown as ScheduleConfig;
		expect(computeNextRun(config, EPOCH)).toBeNull();
	});
});

describe("validateCronExpression", () => {
	it("returns true for a valid expression", () => {
		expect(validateCronExpression("0 0 * * *")).toBe(true);
		expect(validateCronExpression("*/5 * * * *")).toBe(true);
	});

	it("returns false for an invalid expression", () => {
		expect(validateCronExpression("")).toBe(false);
		expect(validateCronExpression("hello world")).toBe(false);
		expect(validateCronExpression("* * * *")).toBe(false);
	});
});

describe("isJobDue", () => {
	it("returns false when nextRunAt is null", () => {
		expect(isJobDue(null, EPOCH)).toBe(false);
	});

	it("returns true when nextRunAt is at or before now", () => {
		expect(isJobDue(EPOCH, EPOCH)).toBe(true);
		expect(isJobDue(new Date(EPOCH.getTime() - 1), EPOCH)).toBe(true);
	});

	it("returns false when nextRunAt is after now", () => {
		expect(isJobDue(new Date(EPOCH.getTime() + 1), EPOCH)).toBe(false);
	});
});

describe("formatDate", () => {
	it("returns an ISO 8601 string", () => {
		expect(formatDate(EPOCH)).toBe("2024-01-01T00:00:00.000Z");
	});
});

describe("parseDate", () => {
	it("passes Date instances through", () => {
		expect(parseDate(EPOCH)).toBe(EPOCH);
	});

	it("parses ISO strings into Dates", () => {
		const result = parseDate("2024-06-15T12:00:00.000Z");
		expect(result.toISOString()).toBe("2024-06-15T12:00:00.000Z");
	});
});

describe("createJobExecutionStreamResponse", () => {
	async function readAllChunks(response: Response): Promise<string> {
		const reader = response.body?.getReader();
		if (!reader) return "";
		const decoder = new TextDecoder();
		let buffer = "";
		let done = false;
		while (!done) {
			const readResult = await reader.read();
			done = readResult.done;
			if (readResult.value) {
				buffer += decoder.decode(readResult.value, { stream: !done });
			}
		}
		buffer += decoder.decode();
		return buffer;
	}

	it("returns a Response with SSE headers", () => {
		const response = createJobExecutionStreamResponse(async () => {});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
		expect(response.headers.get("Connection")).toBe("keep-alive");
	});

	it("streams data events emitted by run", async () => {
		const events: JobAgentStreamEvent[] = [
			{ type: "text", content: "hello" },
			{ type: "execution_done", executionId: "exec-1", status: "success" },
		];
		const response = createJobExecutionStreamResponse(async (send) => {
			for (const event of events) send(event);
		});

		const body = await readAllChunks(response);
		expect(body).toContain('data: {"type":"text","content":"hello"}\n\n');
		expect(body).toContain('data: {"type":"execution_done","executionId":"exec-1","status":"success"}\n\n');
	});

	it("streams an error event when run throws", async () => {
		const response = createJobExecutionStreamResponse(async () => {
			throw new Error("boom");
		});

		const body = await readAllChunks(response);
		expect(body).toContain('data: {"type":"error","content":"boom"}\n\n');
	});

	it("streams an error event for non-Error throws", async () => {
		const response = createJobExecutionStreamResponse(async () => {
			throw "string error";
		});

		const body = await readAllChunks(response);
		expect(body).toContain('data: {"type":"error","content":"string error"}\n\n');
	});
});
