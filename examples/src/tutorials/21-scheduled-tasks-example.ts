import { computeNextRun, validateCronExpression } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// Validate a cron expression
	const isValid = validateCronExpression("0 9 * * *"); // Daily at 9 AM
	console.log("Cron valid:", isValid);

	// Compute next run time. computeNextRun takes a ScheduleConfig object.
	const nextRun = computeNextRun({ type: "cron", expression: "0 9 * * *" }, new Date());

	if (nextRun) {
		console.log("Next run:", nextRun.toISOString());
	} else {
		console.log("No next run scheduled");
	}
}

export default main;
runIfMain("scheduled-tasks", main, import.meta.url);
