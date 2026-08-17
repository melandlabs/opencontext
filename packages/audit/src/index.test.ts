import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry, CredentialAccessEntry } from "./index";

interface AuditModule {
	AUDIT_LOG_PATH: string;
	logFileRead: (filePath: string) => void;
	logCommandExec: (command: string, args?: string[]) => void;
	logCredentialAccess: (params: {
		accountId: string;
		userId: string;
		action: "read" | "update" | "rotate" | "delete";
		ipAddress?: string;
		userAgent?: string;
		metadata?: Record<string, unknown>;
		success: boolean;
		errorMessage?: string;
	}) => void;
	readAuditLogs: (options?: {
		type?: "file_read" | "command_exec";
		limit?: number;
		offset?: number;
	}) => { entries: AuditEntry[]; total: number };
	clearAuditLogs: () => void;
}

describe("@melandlabs/audit", () => {
	let tempDir: string;
	let audit: AuditModule;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("USERPROFILE", tempDir);
		vi.resetModules();
		const mod = (await import("./index")) as AuditModule;
		audit = mod;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe("AUDIT_LOG_PATH", () => {
		it("exports the documented default log path", () => {
			expect(audit.AUDIT_LOG_PATH).toBe("~/.opencontext/logs/audit.jsonl");
		});
	});

	describe("logFileRead", () => {
		it("writes a file_read entry in JSONL format", () => {
			audit.logFileRead("/etc/passwd");

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			expect(fs.existsSync(logFile)).toBe(true);

			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(1);

			const entry = JSON.parse(lines[0]) as AuditEntry;
			expect(entry.type).toBe("file_read");
			expect(entry.detail).toBe("/etc/passwd");
			expect(typeof entry.timestamp).toBe("string");
			expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
		});
	});

	describe("logCommandExec", () => {
		it("writes a command_exec entry without args", () => {
			audit.logCommandExec("ls");

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(1);

			const entry = JSON.parse(lines[0]) as AuditEntry;
			expect(entry.type).toBe("command_exec");
			expect(entry.detail).toBe("ls");
			expect(entry.extra).toBeUndefined();
		});

		it("writes a command_exec entry with args", () => {
			audit.logCommandExec("git", ["commit", "-m", "wip"]);

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(1);

			const entry = JSON.parse(lines[0]) as AuditEntry;
			expect(entry.type).toBe("command_exec");
			expect(entry.detail).toBe("git");
			expect(entry.extra).toEqual({ args: ["commit", "-m", "wip"] });
		});

		it("omits extra when args is empty", () => {
			audit.logCommandExec("clear", []);

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			const entry = JSON.parse(lines[0]) as AuditEntry;
			expect(entry.extra).toBeUndefined();
		});
	});

	describe("logCredentialAccess", () => {
		it("writes a credential_access entry with all fields", () => {
			audit.logCredentialAccess({
				accountId: "acc-123",
				userId: "user-456",
				action: "read",
				ipAddress: "192.168.1.1",
				userAgent: "Mozilla/5.0",
				metadata: { provider: "aws" },
				success: true,
			});

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(1);

			const entry = JSON.parse(lines[0]) as CredentialAccessEntry;
			expect(entry.type).toBe("credential_access");
			expect(entry.accountId).toBe("acc-123");
			expect(entry.userId).toBe("user-456");
			expect(entry.action).toBe("read");
			expect(entry.ipAddress).toBe("192.168.1.1");
			expect(entry.userAgent).toBe("Mozilla/5.0");
			expect(entry.metadata).toEqual({ provider: "aws" });
			expect(entry.success).toBe(true);
			expect(entry.errorMessage).toBeUndefined();
		});

		it("writes a credential_access entry for a failed update", () => {
			audit.logCredentialAccess({
				accountId: "acc-789",
				userId: "user-000",
				action: "update",
				success: false,
				errorMessage: "Permission denied",
			});

			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
			const entry = JSON.parse(lines[0]) as CredentialAccessEntry;
			expect(entry.type).toBe("credential_access");
			expect(entry.action).toBe("update");
			expect(entry.success).toBe(false);
			expect(entry.errorMessage).toBe("Permission denied");
			expect(entry.ipAddress).toBeUndefined();
		});
	});

	describe("readAuditLogs", () => {
		it("returns an empty array when no logs exist", () => {
			const result = audit.readAuditLogs();
			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
		});

		it("reads entries in reverse chronological order", () => {
			audit.logFileRead("/first");
			audit.logFileRead("/second");
			audit.logFileRead("/third");

			const result = audit.readAuditLogs();
			expect(result.total).toBe(3);
			expect(result.entries.map((e) => e.detail)).toEqual(["/third", "/second", "/first"]);
		});

		it("filters entries by type", () => {
			audit.logFileRead("/secret");
			audit.logCommandExec("rm", ["-rf", "/"]);
			audit.logFileRead("/another-secret");

			const result = audit.readAuditLogs({ type: "file_read" });
			expect(result.total).toBe(2);
			expect(result.entries.every((e) => e.type === "file_read")).toBe(true);
			expect(result.entries.map((e) => e.detail)).toEqual(["/another-secret", "/secret"]);
		});

		it("supports limit and offset pagination", () => {
			for (let i = 1; i <= 5; i++) {
				audit.logFileRead(`/file-${i}`);
			}

			const page1 = audit.readAuditLogs({ limit: 2, offset: 0 });
			expect(page1.entries.map((e) => e.detail)).toEqual(["/file-5", "/file-4"]);
			expect(page1.total).toBe(5);

			const page2 = audit.readAuditLogs({ limit: 2, offset: 2 });
			expect(page2.entries.map((e) => e.detail)).toEqual(["/file-3", "/file-2"]);

			const page3 = audit.readAuditLogs({ limit: 2, offset: 4 });
			expect(page3.entries.map((e) => e.detail)).toEqual(["/file-1"]);
		});

		it("uses a default limit of 200", () => {
			for (let i = 1; i <= 250; i++) {
				audit.logFileRead(`/file-${i}`);
			}

			const result = audit.readAuditLogs();
			expect(result.total).toBe(250);
			expect(result.entries).toHaveLength(200);
		});

		it("round-trips JSONL entries", () => {
			audit.logCommandExec("echo", ["hello"]);
			audit.logCredentialAccess({
				accountId: "a",
				userId: "u",
				action: "rotate",
				success: true,
			});

			const result = audit.readAuditLogs();
			expect(result.total).toBe(2);

			const commandEntry = result.entries.find((e) => e.type === "command_exec") as AuditEntry;
			expect(commandEntry.detail).toBe("echo");
			expect(commandEntry.extra).toEqual({ args: ["hello"] });

			const credentialEntry = result.entries.find(
				(e) => e.type === "credential_access",
			) as CredentialAccessEntry;
			expect(credentialEntry.accountId).toBe("a");
			expect(credentialEntry.action).toBe("rotate");
			expect(credentialEntry.success).toBe(true);
		});

		it("skips malformed JSONL lines without crashing", () => {
			audit.logFileRead("/valid");
			const logFile = path.join(tempDir, ".opencontext", "logs", "audit.jsonl");
			fs.appendFileSync(logFile, "not valid json\n");
			audit.logCommandExec("ls");

			const result = audit.readAuditLogs();
			expect(result.total).toBe(2);
			expect(result.entries.map((e) => e.detail)).toEqual(["ls", "/valid"]);
		});
	});

	describe("clearAuditLogs", () => {
		it("removes all entries from the log file", () => {
			audit.logFileRead("/secret");
			audit.logCommandExec("whoami");

			let result = audit.readAuditLogs();
			expect(result.total).toBe(2);

			audit.clearAuditLogs();

			result = audit.readAuditLogs();
			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
		});

		it("is a no-op when no log file exists", () => {
			expect(() => audit.clearAuditLogs()).not.toThrow();
			expect(audit.readAuditLogs().total).toBe(0);
		});
	});
});
