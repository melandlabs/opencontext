/**
 * Tutorial: cron scheduling primitives.
 *
 * This example demonstrates the @melandlabs/opencontext cron exports:
 *
 *   - validateCronExpression(expression)
 *   - computeNextRun(scheduleConfig, now?)
 *   - isJobDue(nextRunAt, now?)
 *
 * It validates a few sample cron expressions, computes upcoming run times,
 * and checks whether a computed next-run timestamp is due relative to a
 * reference time.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/29-cron-example.ts
 */

import { runIfMain } from "../_helpers.ts";
import { computeNextRun, isJobDue, validateCronExpression } from "@melandlabs/opencontext";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- validateCronExpression is callable: ${typeof validateCronExpression === "function"}`);
	console.log(`- computeNextRun is callable: ${typeof computeNextRun === "function"}`);
	console.log(`- isJobDue is callable: ${typeof isJobDue === "function"}`);

	if (typeof validateCronExpression !== "function") {
		throw new Error("validateCronExpression is not exported as a function");
	}
	if (typeof computeNextRun !== "function") {
		throw new Error("computeNextRun is not exported as a function");
	}
	if (typeof isJobDue !== "function") {
		throw new Error("isJobDue is not exported as a function");
	}

	// ---- Expression validation ----
	console.log("\nValidating cron expressions:");
	const validExpressions = ["0 9 * * *", "*/15 * * * *", "0 0 * * 0", "30 14 1 * *"];
	const invalidExpressions = ["not-a-cron", "60 9 * * *", "0 9 * * 8"];

	for (const expression of validExpressions) {
		const ok = validateCronExpression(expression);
		console.log(`- "${expression}" valid=${ok}`);
		if (!ok) {
			throw new Error(`Expected "${expression}" to be a valid cron expression`);
		}
	}

	for (const expression of invalidExpressions) {
		const ok = validateCronExpression(expression);
		console.log(`- "${expression}" valid=${ok}`);
		if (ok) {
			throw new Error(`Expected "${expression}" to be an invalid cron expression`);
		}
	}

	// ---- Next-run computation ----
	console.log("\nComputing next run times:");
	const now = new Date("2026-01-01T12:00:00Z");

	const dailyNineAm = computeNextRun({ type: "cron", expression: "0 9 * * *", timezone: "UTC" }, now);
	console.log(`- 0 9 * * * from ${now.toISOString()}: ${dailyNineAm?.toISOString() ?? "null"}`);
	if (!dailyNineAm || dailyNineAm.getTime() !== Date.parse("2026-01-02T09:00:00Z")) {
		throw new Error(`Unexpected next run for daily 9am: ${dailyNineAm?.toISOString()}`);
	}

	const everyFifteen = computeNextRun({ type: "cron", expression: "*/15 * * * *", timezone: "UTC" }, now);
	console.log(`- */15 * * * * from ${now.toISOString()}: ${everyFifteen?.toISOString() ?? "null"}`);
	if (!everyFifteen || everyFifteen.getTime() !== Date.parse("2026-01-01T12:15:00Z")) {
		throw new Error(`Unexpected next run for every-15-minutes: ${everyFifteen?.toISOString()}`);
	}

	const oneHourInterval = computeNextRun({ type: "interval-hours", hours: 1 }, now);
	console.log(`- interval 1h from ${now.toISOString()}: ${oneHourInterval?.toISOString() ?? "null"}`);
	if (!oneHourInterval || oneHourInterval.getTime() !== Date.parse("2026-01-01T13:00:00Z")) {
		throw new Error(`Unexpected next run for 1h interval: ${oneHourInterval?.toISOString()}`);
	}

	const onceInPast = computeNextRun({ type: "once", at: "2020-01-01T00:00:00Z" }, now);
	console.log(`- once in the past from ${now.toISOString()}: ${onceInPast?.toISOString() ?? "null"}`);
	if (onceInPast !== null) {
		throw new Error("Expected once-in-the-past schedule to return null");
	}

	// ---- Due check ----
	console.log("\nChecking isJobDue:");
	const futureRun = new Date("2026-01-01T13:00:00Z");
	const pastRun = new Date("2026-01-01T11:00:00Z");
	const futureDue = isJobDue(futureRun, now);
	const pastDue = isJobDue(pastRun, now);
	console.log(`- future run at ${futureRun.toISOString()} is due=${futureDue}`);
	console.log(`- past run at ${pastRun.toISOString()} is due=${pastDue}`);

	if (futureDue) {
		throw new Error("Expected future run not to be due");
	}
	if (!pastDue) {
		throw new Error("Expected past run to be due");
	}
	if (isJobDue(null, now)) {
		throw new Error("Expected null nextRunAt to be not due");
	}

	console.log("\n[OK] Cron tutorial completed");
}

export default main;

runIfMain("Cron tutorial", main);
