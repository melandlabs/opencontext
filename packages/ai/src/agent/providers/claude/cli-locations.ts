/**
 * Candidate resource directories shared by Claude Code execution and
 * readiness probes. Keeping this list in one place prevents a packaged CLI
 * from working for tasks while being reported as missing in Settings.
 */

import { dirname, join } from "node:path";

export function getClaudeBundleDirectories(cwd = process.cwd(), executablePath = process.execPath): string[] {
	const executableDirectory = dirname(executablePath);
	return Array.from(
		new Set([
			join(cwd, "apps", "web", "cli-bundle"),
			join(cwd, "cli-bundle"),
			join(cwd, "..", "web", "cli-bundle"),
			join(executableDirectory, "cli-bundle"),
			join(executableDirectory, "..", "Resources", "cli-bundle"),
			join(executableDirectory, "..", "Resources", "_up_", "src-api", "dist", "cli-bundle"),
			join(executableDirectory, "_up_", "src-api", "dist", "cli-bundle"),
			join(executableDirectory, "..", "lib", "opencontext", "_up_", "src-api", "dist", "cli-bundle"),
			join(executableDirectory, "claude-bundle"),
			join(executableDirectory, "..", "Resources", "claude-bundle"),
		]),
	);
}
