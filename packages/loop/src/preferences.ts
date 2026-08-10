/**
 * Loop preferences — read/write the user's local config.json. Defaults
 * are applied on missing fields so partially-written files self-heal.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LOOP_PATHS, ensureDirs, ensureParent } from "./paths";

/**
 * Quiet-day filler module identifier. The Loop picks one when
 * `quietWhenEmpty` is true and a brief / wrap snapshot comes up
 * empty. See issue #316 for the rationale behind giving "nothing to
 * dismiss" an actual module instead of a hard skip.
 */
export type QuietDayFillerId = "none" | "ai-news-digest" | "weather-calendar" | "memory-resurface";

/**
 * The shape persisted to `~/.opencontext/loop/config.json`. New
 * opt-in fields should default to `false` (or a benign sentinel) so
 * that upgrading users aren't suddenly opted into a feature.
 */
export interface LoopPreferences {
	enabled: boolean;
	/**
	 * 24h HH:MM local time, or `null` to skip the morning brief job entirely.
	 * #417 — Loop defaults to fully off on a fresh install; the user opts in
	 * to the tick, brief, and wrap jobs independently via the settings panel.
	 * Setting `briefTime` to `null` makes `scheduler.ensureLoopJobs` delete
	 * the brief cron row if it exists and never recreate it, so a user can
	 * run Loop with ticks but no morning brief — or no wrap at all.
	 */
	briefTime: string | null;
	/**
	 * 24h HH:MM local time, or `null` to skip the evening wrap job entirely.
	 * See `briefTime` for the rationale (#417).
	 */
	wrapTime: string | null;
	/** Tick interval seconds. */
	intervalSec: number;
	/** Hard-skip patterns. */
	noReplySkip: boolean;
	promotionSkip: boolean;
	/**
	 * IANA timezone the brief/wrap cron rows should be anchored to. Empty
	 * (or omitted) means "derive from the host's `Intl.DateTimeFormat`". The
	 * settings panel populates this from `Intl.DateTimeFormat().resolvedOptions().timeZone`
	 * on PUT so a containerised server (whose Intl is usually UTC) still
	 * honours the user's wall-clock 09:00 / 21:00.
	 */
	timezone?: string;
	/**
	 * Generate agentic narrative summary for brief/wrap. When `false`, brief
	 * and wrap fall back to the deterministic templated dialogue. Default
	 * `true` — opt-out via `PUT /api/loop/preferences { narrative: false }`.
	 */
	narrative?: boolean;
	/**
	 * Send native macOS / OS desktop notifications for high-priority Loop
	 * events. Default `false` because the Loomi Pet bubble/card is the
	 * primary desktop surface and is always on. Opt-in via
	 * `PUT /api/loop/preferences { desktopNotifications: true }`.
	 */
	desktopNotifications?: boolean;
	/**
	 * When `true`, a *user-created* scheduled cron job POSTs a transient
	 * Loomi pet **bubble** message on completion (both success and error).
	 * This is a bubble-only surface — explicitly NOT a decision card, so it
	 * carries no Run/Dismiss buttons and auto-dismisses on the bubble's own
	 * timer. Loop's own jobs (`loop.tick` / `loop.brief` / `loop.wrap` /
	 * `loop.action`) are excluded — they already reach the pet as decision
	 * cards via the `decisions.json` watcher.
	 *
	 * Default `false` — opt-in via
	 * `PUT /api/loop/preferences { cronCompletionPetNotify: true }`.
	 */
	cronCompletionPetNotify?: boolean;
	/**
	 * SP-4 — daily OS-notification budget. Caps the number of native
	 * desktop notifications fired by `notifyForDecisions` per
	 * user-local day, so a slack flood can't bury the user.
	 *
	 * `daily`         — max notifications per day. Default `3`.
	 * `p0BypassBudget`— when `true` (default), P0-priority decisions
	 *                   always notify regardless of the daily count.
	 *                   Set to `false` to enforce the budget
	 *                   uniformly.
	 *
	 * Lives on `LoopPreferences` (next to `desktopNotifications`,
	 * which gates the same fan-out) rather than as a new top-level
	 * setting, so the same PUT body that opts the user in also
	 * shapes how often they want to be pestered. The counter itself
	 * is persisted to `~/.opencontext/loop/attention.json` (NOT
	 * `config.json`) to avoid a write-race on the preferences path.
	 */
	attentionBudget?: {
		daily: number;
		p0BypassBudget?: boolean;
	};
	/**
	 * SP-4 — per-source cooldown. When a user dismisses a notification,
	 * the dismiss writes a `cooldown_until` onto the matching mute
	 * rule. `notifyForDecisions` consults this window before firing
	 * another OS notification for the same source, suppressing
	 * repeated pings of an action the user already swiped away.
	 *
	 * `windowSec` — seconds to suppress after a dismiss. Default
	 *               `1800` (30 min). Set to `0` to disable.
	 *
	 * Shared storage with `MuteRule` so dismiss-driven cooldowns
	 * inherit the existing on-disk shape + cache-invalidation
	 * discipline. Cooldown is additive: it does NOT replace
	 * `mutes.has()` — a muted rule still blocks; a cooldown-only
	 * rule just throttles the next nudge.
	 */
	cooldown?: {
		windowSec: number;
	};
	/**
	 * When the brief or wrap snapshot is empty (no surfaced items /
	 * highlights), skip the templated "nothing to do" card entirely.
	 * Snapshot still gets persisted to `~/.opencontext/loop/{brief,wrap}.json`
	 * for history; the pet bubble stays silent and no badge increments.
	 *
	 * Default `true` — opt-out via
	 * `PUT /api/loop/preferences { quietWhenEmpty: false }` to restore the
	 * legacy "open a card to dismiss nothing" behaviour. See issue #316.
	 */
	quietWhenEmpty?: boolean;
	/**
	 * Optional content module to run when the quiet path fires. The module
	 * produces a `type:"quiet_digest"` decision card in place of the
	 * templated empty card, turning "nothing to dismiss" into "the card
	 * worth opening" — e.g. a news digest, weather + first meeting, or a
	 * resurfaced memory.
	 *
	 * Default `"none"` (skip the card entirely). Built-ins:
	 *   - "ai-news-digest"  → 3 last-24h AI / tech headlines
	 *   - "weather-calendar" → weather + first 2 calendar events
	 *   - "memory-resurface" → 2 stale insights from the user's memory
	 *
	 * No-op when `quietWhenEmpty === false`. See issue #316.
	 */
	quietDayFiller?: QuietDayFillerId;
}

export const DEFAULT_LOOP_PREFERENCES: LoopPreferences = {
	// #417 — Loop is OFF by default. Fresh installs must opt in
	// explicitly via the settings panel; the cron executor does not
	// poll any of Loop's three ScheduledJob rows (`loop.tick` /
	// `loop.brief` / `loop.wrap`) on a fresh install. Users who
	// already have `config.json` with `enabled: true` set are
	// grandfathered — `readPreferences()` shallow-merges defaults
	// under the persisted file, so flipping this default cannot
	// disable an install that already opted in.
	enabled: false,
	// #417 — brief/wrap are separately opt-in. `null` means the
	// matching cron row is removed (and never recreated) by
	// `scheduler.ensureLoopJobs`. Tick interval is the same as
	// before since the off-by-default flag already prevents it
	// from running on fresh installs.
	briefTime: null,
	wrapTime: null,
	intervalSec: 600,
	noReplySkip: true,
	promotionSkip: true,
	narrative: true,
	desktopNotifications: false, // NEW
	cronCompletionPetNotify: false, // NEW — opt-in transient pet bubble
	quietWhenEmpty: true, // NEW (#316) — opt-out via prefs
	quietDayFiller: "none", // NEW (#316) — opt into a module
	// SP-4 — daily OS-notification budget. Three notifications per
	// user-local day is enough for a typical "morning brief + a
	// urgent PR + an evening wrap" flow; anything beyond that almost
	// always indicates either a stuck watcher or a sender that
	// shouldn't have hit Loop at all. P0 still bypasses by default
	// so a real urgent signal (RSVP in <1h, hard deadline) never
	// gets dropped.
	attentionBudget: { daily: 3, p0BypassBudget: true },
	// SP-4 — 30-minute per-source cooldown after a dismiss. Long
	// enough to ride out a "boss said something, then said it again
	// in a thread reply" pattern, short enough that an actually
	// distinct follow-up from the same sender still reaches the
	// user before EOD.
	cooldown: { windowSec: 1800 },
};

export function readPreferences(): LoopPreferences {
	ensureDirs();
	if (!existsSync(LOOP_PATHS.config)) {
		return { ...DEFAULT_LOOP_PREFERENCES };
	}
	try {
		const raw = JSON.parse(readFileSync(LOOP_PATHS.config, "utf8")) as Partial<LoopPreferences>;
		return { ...DEFAULT_LOOP_PREFERENCES, ...(raw ?? {}) };
	} catch {
		return { ...DEFAULT_LOOP_PREFERENCES };
	}
}

export function writePreferences(patch: Partial<LoopPreferences>): LoopPreferences {
	ensureDirs();
	const next: LoopPreferences = { ...readPreferences(), ...(patch ?? {}) };
	ensureParent(LOOP_PATHS.config);
	try {
		writeFileSync(LOOP_PATHS.config, JSON.stringify(next, null, 2));
	} catch (e) {
		console.warn("[loop.preferences] write failed:", e);
	}
	return next;
}
