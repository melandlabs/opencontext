import { computeNextRun, validateCronExpression } from "@melandlabs/opencontext";

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

main().catch((error) => {
	console.error("Scheduled task example failed:", error);
	process.exit(1);
});
