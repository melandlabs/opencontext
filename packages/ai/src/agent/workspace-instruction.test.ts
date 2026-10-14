/**
 * `getWorkspaceInstruction` must describe only the tools the host actually
 * registered. Naming a tool the model cannot call produces a hard mid-task
 * error ("No such tool available: mcp__bash__Bash"), so the shell capability
 * is an explicit input and defaults to "no shell".
 *
 * `formatPlanForExecution` must forward that capability unchanged — the four
 * CLI providers build their execution prompt through it.
 */
import { describe, expect, it } from "vitest";

import {
	type WorkspaceShellCapability,
	formatPlanForExecution,
	getWorkspaceInstruction,
	resolveCliShellCapability,
} from "./base";
import type { TaskPlan } from "./types";

const WORK_DIR = "/tmp/opencontext/workspace";

function render(shell?: WorkspaceShellCapability): string {
	return getWorkspaceInstruction(WORK_DIR, undefined, "Asia/Shanghai", "zh-Hans", shell);
}

const POSIX: WorkspaceShellCapability = {
	kind: "shell",
	toolName: "mcp__bash__Bash",
	dialect: "posix",
};

const POWERSHELL: WorkspaceShellCapability = {
	kind: "shell",
	toolName: "PowerShell",
	dialect: "powershell",
};

describe("getWorkspaceInstruction — default (no shell declared)", () => {
	const instruction = render();

	it("never names a shell tool or a POSIX command", () => {
		expect(instruction).not.toContain("mcp__bash__Bash");
		expect(instruction).not.toContain("find ~/");
		expect(instruction).not.toContain("ls -lt");
		expect(instruction).not.toContain("$(date");
		expect(instruction).not.toContain("mkdir -p");
	});

	it("tells the model there is no shell and forbids calling one", () => {
		expect(instruction).toContain("No shell tool is available");
	});

	it("keeps the workspace safety rules intact", () => {
		expect(instruction).toContain("BACKUP BEFORE ANY DESTRUCTIVE OPERATION OUTSIDE THE WORKSPACE");
		expect(instruction).toContain("ask the user for confirmation");
		expect(instruction).toContain("are EXEMPT");
	});
});

describe("getWorkspaceInstruction — posix shell", () => {
	const instruction = render(POSIX);

	it("names the host-provided tool and uses POSIX recipes", () => {
		expect(instruction).toContain("mcp__bash__Bash");
		expect(instruction).toContain("find ~/Downloads");
		expect(instruction).toContain("date +%Y%m%d_%H%M%S");
	});

	it("does not leak PowerShell recipes", () => {
		expect(instruction).not.toContain("Get-ChildItem");
		expect(instruction).not.toContain("Copy-Item");
		expect(instruction).not.toContain("New-Item");
	});
});

describe("getWorkspaceInstruction — powershell shell", () => {
	const instruction = render(POWERSHELL);

	it("names the host-provided tool and uses PowerShell recipes", () => {
		expect(instruction).toContain("PowerShell");
		expect(instruction).toContain("Get-ChildItem");
		expect(instruction).toContain("Copy-Item");
	});

	it("does not leak POSIX recipes", () => {
		expect(instruction).not.toContain("find ~/");
		expect(instruction).not.toContain("cp -r");
		expect(instruction).not.toContain("$(date");
	});
});

describe("getWorkspaceInstruction — size guard", () => {
	it.each([
		["none", undefined],
		["posix", POSIX],
		["powershell", POWERSHELL],
	] as const)("stays under 16000 characters (%s)", (_label, shell) => {
		expect(render(shell).length).toBeLessThan(16000);
	});
});

describe("resolveCliShellCapability", () => {
	it("picks the POSIX tool name off Windows", () => {
		expect(
			resolveCliShellCapability({
				posixToolName: "Bash",
				windowsToolName: "PowerShell",
				platform: "darwin",
			}),
		).toEqual({ kind: "shell", toolName: "Bash", dialect: "posix" });
	});

	it("switches tool name and dialect on Windows", () => {
		expect(
			resolveCliShellCapability({
				posixToolName: "Bash",
				windowsToolName: "PowerShell",
				platform: "win32",
			}),
		).toEqual({ kind: "shell", toolName: "PowerShell", dialect: "powershell" });
	});
});

describe("formatPlanForExecution — shell passthrough", () => {
	const plan: TaskPlan = {
		id: "plan_1",
		goal: "Summarize the quarterly report",
		steps: [{ id: "step_1", description: "Read the report", status: "pending" }],
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};

	it("forwards the shell capability to the workspace instruction", () => {
		const withPosix = formatPlanForExecution(
			plan,
			WORK_DIR,
			undefined,
			undefined,
			"zh-Hans",
			"Asia/Shanghai",
			POSIX,
		);
		const withNone = formatPlanForExecution(plan, WORK_DIR, undefined, undefined, "zh-Hans", "Asia/Shanghai");

		expect(withPosix).toContain("mcp__bash__Bash");
		expect(withNone).not.toContain("mcp__bash__Bash");
		expect(withNone).toContain("No shell tool is available");
	});
});
