import { logCommandExec, logFileRead, readAuditLogs } from "@melandlabs/opencontext";

async function main() {
	logFileRead("/etc/passwd");
	logCommandExec("git", ["status"]);

	const { entries, total } = readAuditLogs({ type: "file_read", limit: 10 });
	console.log(`Total file-read audit entries: ${total}`);
	for (const entry of entries) {
		console.log(`[${entry.type}] ${entry.detail}`);
	}
}

main().catch((error) => {
	console.error("Audit logging example failed:", error);
	process.exit(1);
});
