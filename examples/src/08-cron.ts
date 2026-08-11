/**
 * demo: @melandlabs/cron — schedule validation and next-run computation.
 *
 * A `ScheduleConfig` is a discriminated union, so a schedule is either a
 * cron expression or one of the interval / one-shot forms:
 *
 *   { type: "cron", expression: "0 9 * * 1-5", timezone?: string }
 *   { type: "interval-hours", hours: number }
 *   { type: "interval-minutes", minutes: number }
 *   { type: "once", at: Date | string }
 *
 * `computeNextRun(config, now)` is pure — pass an explicit `now` and it is
 * fully deterministic, which is what makes scheduling testable.
 */

import { type ScheduleConfig, computeNextRun, validateCronExpression } from "@melandlabs/cron";
import { info, makeCheck, runSection } from "./_helpers.ts";

/** Fixed clock so every assertion below is deterministic. */
const NOW = new Date("2026-03-02T08:00:00.000Z"); // a Monday

export default async function demoCron() {
	await runSection("demo: @melandlabs/cron", async () => {
		const check = makeCheck("demo/cron");

		// 1. Validate cron expressions before you store them.
		info("demo/cron", `validateCronExpression("*/5 * * * *") = ${validateCronExpression("*/5 * * * *")}`);
		info("demo/cron", `validateCronExpression("not a cron") = ${validateCronExpression("not a cron")}`);
		check("a valid 5-field cron expression is accepted", validateCronExpression("*/5 * * * *") === true);
		check("a weekday-morning cron is accepted", validateCronExpression("0 9 * * 1-5") === true);
		check("garbage is rejected", validateCronExpression("not a cron") === false);
		check("an empty expression is rejected", validateCronExpression("") === false);

		// 2. Interval schedules: next run is `now` plus the interval.
		const everyTwoHours: ScheduleConfig = { type: "interval-hours", hours: 2 };
		const next = computeNextRun(everyTwoHours, NOW);
		info("demo/cron", `interval-hours:2 from ${NOW.toISOString()} → ${next?.toISOString()}`);
		check("interval-hours returns a Date", next instanceof Date);
		check(
			"interval-hours:2 lands exactly two hours after now",
			next!.getTime() - NOW.getTime() === 2 * 60 * 60 * 1000,
		);

		const everyThirty: ScheduleConfig = { type: "interval-minutes", minutes: 30 };
		const next30 = computeNextRun(everyThirty, NOW);
		info("demo/cron", `interval-minutes:30 → ${next30?.toISOString()}`);
		check(
			"interval-minutes:30 lands exactly thirty minutes after now",
			next30!.getTime() - NOW.getTime() === 30 * 60 * 1000,
		);

		// 3. One-shot schedules: in the future they run, in the past they don't.
		const future: ScheduleConfig = { type: "once", at: "2026-03-02T09:30:00.000Z" };
		const past: ScheduleConfig = { type: "once", at: "2020-01-01T00:00:00.000Z" };
		const futureRun = computeNextRun(future, NOW);
		const pastRun = computeNextRun(past, NOW);
		info("demo/cron", `once@future → ${futureRun?.toISOString()}, once@past → ${pastRun}`);
		check(
			"a future one-shot returns its scheduled time",
			futureRun?.toISOString() === "2026-03-02T09:30:00.000Z",
		);
		check("an elapsed one-shot returns null — it will not run again", pastRun === null);
		check(
			"an unparseable one-shot date returns null",
			computeNextRun({ type: "once", at: "nonsense" }, NOW) === null,
		);

		// 4. Determinism: same inputs, same output.
		check(
			"computeNextRun is pure — the same inputs give the same answer",
			computeNextRun(everyTwoHours, NOW)?.getTime() === next!.getTime(),
		);
	});
}
