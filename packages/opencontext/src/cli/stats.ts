/**
 * `opencontext stats` — surface counts from the active raw-message store.
 *
 * Models memvid's `stats`: one line per dimension, machine-greppable. The
 * underlying `manager.getStats()` returns a global view across all users
 * and platforms, so this command does not take a `--user` filter — it
 * is intentionally a "what's in the box?" diagnostic, not a per-tenant
 * report. Use `opencontext list --user <id> | wc -l` if you need a
 * per-user count.
 *
 * Exit codes:
 *   0 — stats printed
 *   1 — backend refused or threw
 *
 * Output:
 *   default        multi-line human report
 *   --json         full `RawMessageStats` envelope
 */

import { getRawMessageManager } from "@melandlabs/memory-store";

// `RawMessageStats` lives in `@melandlabs/indexeddb` and isn't re-exported
// by `@melandlabs/memory-store` yet. We mirror the relevant surface here so
// the CLI doesn't pull a new package dependency; if the upstream gains
// fields we don't read, they're ignored harmlessly.
export interface RawMessageStats {
	totalMessages: number;
	messagesByPlatform: Record<string, number>;
	messagesByBot: Record<string, number>;
	oldestMessage?: number;
	newestMessage?: number;
}

export interface StatsOptions {
	json: boolean;
}

export interface StatsEnvelope {
	ok: boolean;
	exit: number;
	stats: RawMessageStats;
	error?: string;
}

const logPrefix = "[opencontext/stats]";

export function parseStatsArgs(argv: string[]): StatsOptions {
	const opts: StatsOptions = { json: false };
	for (const arg of argv) {
		switch (arg) {
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				printStatsHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`${logPrefix} unknown flag: ${arg}`);
		}
	}
	return opts;
}

export async function runStats(opts: StatsOptions): Promise<number> {
	const manager = await getRawMessageManager();
	let stats: RawMessageStats;
	try {
		stats = await manager.getStats();
	} catch (error) {
		const message = (error as Error).message;
		const env: StatsEnvelope = {
			ok: false,
			exit: 1,
			stats: {
				totalMessages: 0,
				messagesByPlatform: {},
				messagesByBot: {},
			},
			error: message,
		};
		process.stdout.write(`${opts.json ? JSON.stringify(env) : `error: ${message}`}\n`);
		return env.exit;
	}

	const env: StatsEnvelope = { ok: true, exit: 0, stats };
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(env)}\n`);
		return env.exit;
	}
	process.stdout.write(`${renderHuman(stats)}\n`);
	return env.exit;
}

function renderHuman(stats: RawMessageStats): string {
	const lines: string[] = [];
	lines.push(`total messages: ${stats.totalMessages}`);
	if (stats.oldestMessage) {
		lines.push(`oldest:         ${new Date(stats.oldestMessage).toISOString()}`);
	}
	if (stats.newestMessage) {
		lines.push(`newest:         ${new Date(stats.newestMessage).toISOString()}`);
	}
	const platforms = Object.entries(stats.messagesByPlatform).sort(([a], [b]) => a.localeCompare(b));
	if (platforms.length > 0) {
		lines.push("by platform:");
		for (const [name, count] of platforms) {
			lines.push(`  ${name.padEnd(16)} ${count}`);
		}
	}
	const bots = Object.entries(stats.messagesByBot).sort(([a], [b]) => a.localeCompare(b));
	if (bots.length > 0) {
		lines.push("by bot:");
		for (const [name, count] of bots) {
			lines.push(`  ${name.padEnd(16)} ${count}`);
		}
	}
	return lines.join("\n");
}

function printStatsHelp(): void {
	console.log(`opencontext stats — report counts from the active raw-message store.

Usage:
  opencontext stats [options]

Options:
  --json                     Emit JSON envelope instead of human report
  --help, -h                 Show this help

Examples:
  opencontext stats
  opencontext stats --json | jq '.stats.totalMessages'`);
}
