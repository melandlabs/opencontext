/**
 * Tutorial: structured audit logging.
 *
 * This example demonstrates the @melandlabs/opencontext audit exports:
 *
 *   - logFileRead(filePath)
 *   - logCommandExec(command, args?)
 *   - readAuditLogs(options?)
 *   - clearAuditLogs()
 *
 * It performs static surface checks, writes a few audit entries, reads them
 * back, asserts the expected entries are present, and clears the log in a
 * finally block so the tutorial does not leave data behind.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/28-audit-example.ts
 */

import { createRequire } from "node:module";
import { runIfMain } from "../_helpers.ts";
import {
	AUDIT_LOG_PATH,
	clearAuditLogs,
	logCommandExec,
	logFileRead,
	readAuditLogs,
} from "@melandlabs/opencontext";

// The audit logger uses dynamic require() for Node built-ins so it can load in
// Edge Runtimes. Provide a global require when running this ESM tutorial.
globalThis.require ??= createRequire(import.meta.url);

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- logFileRead is callable: ${typeof logFileRead === "function"}`);
	console.log(`- logCommandExec is callable: ${typeof logCommandExec === "function"}`);
	console.log(`- readAuditLogs is callable: ${typeof readAuditLogs === "function"}`);
	console.log(`- clearAuditLogs is callable: ${typeof clearAuditLogs === "function"}`);
	console.log(`- AUDIT_LOG_PATH is a string: ${typeof AUDIT_LOG_PATH === "string"} (${AUDIT_LOG_PATH})`);

	if (typeof logFileRead !== "function") {
		throw new Error("logFileRead is not exported as a function");
	}
	if (typeof logCommandExec !== "function") {
		throw new Error("logCommandExec is not exported as a function");
	}
	if (typeof readAuditLogs !== "function") {
		throw new Error("readAuditLogs is not exported as a function");
	}
	if (typeof clearAuditLogs !== "function") {
		throw new Error("clearAuditLogs is not exported as a function");
	}
	if (typeof AUDIT_LOG_PATH !== "string") {
		throw new Error("AUDIT_LOG_PATH is not exported as a string");
	}

	// Start from a clean log so the read-back assertions are deterministic.
	clearAuditLogs();

	try {
		// ---- Live audit logging ----
		console.log("\nWriting audit entries...");
		logFileRead("/tmp/tutorial-sensitive-file.txt");
		logCommandExec("git", ["status", "--short"]);

		// ---- Read back and verify ----
		console.log("Reading audit logs back...");
		const { entries, total } = readAuditLogs({ limit: 10 });
		console.log(`- total entries: ${total}`);

		if (total < 2) {
			throw new Error(`Expected at least 2 audit entries, got ${total}`);
		}

		const fileReads = entries.filter((e) => e.type === "file_read");
		const commandExecs = entries.filter((e) => e.type === "command_exec");

		if (fileReads.length === 0) {
			throw new Error("No file_read entry found after logging");
		}
		if (commandExecs.length === 0) {
			throw new Error("No command_exec entry found after logging");
		}

		const lastFileRead = fileReads[0];
		if (!lastFileRead.detail.includes("tutorial-sensitive-file.txt")) {
			throw new Error(`Unexpected file_read detail: ${lastFileRead.detail}`);
		}

		const lastCommandExec = commandExecs[0];
		if (lastCommandExec.detail !== "git") {
			throw new Error(`Unexpected command_exec detail: ${lastCommandExec.detail}`);
		}

		console.log(`- latest file_read: ${lastFileRead.detail}`);
		console.log(`- latest command_exec: ${lastCommandExec.detail}`);
		console.log("\n[OK] Audit tutorial completed");
	} finally {
		clearAuditLogs();
		console.log("Audit logs cleared.");
	}
}

export default main;

runIfMain("Audit tutorial", main);
