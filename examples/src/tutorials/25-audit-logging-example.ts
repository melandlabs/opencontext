import { logCommandExec, logFileRead, readAuditLogs } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	logFileRead("/etc/passwd");
	logCommandExec("git", ["status"]);

	const { entries, total } = readAuditLogs({ type: "file_read", limit: 10 });
	console.log(`Total file-read audit entries: ${total}`);
	for (const entry of entries) {
		console.log(`[${entry.type}] ${entry.detail}`);
	}
}

export default main;
runIfMain("audit-logging", main, import.meta.url);
