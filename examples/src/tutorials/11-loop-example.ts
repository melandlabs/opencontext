import { LOOP_PATHS, ensureDirs, readPreferences, writePreferences } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// Ensure Loop directories exist
	ensureDirs();

	// Read current preferences (or get defaults)
	const prefs = readPreferences();
	console.log("Current interval:", prefs.intervalSec, "seconds");
	console.log("Loop paths:", LOOP_PATHS);

	// Update preferences
	const updated = writePreferences({
		intervalSec: 300, // Run every 5 minutes
		narrative: true, // Enable narrative mode
		enabled: true, // Enable Loop
	});

	console.log("Updated preferences:", updated);
}

export default main;
runIfMain("loop-example", main, import.meta.url);
