import type { GroupByType, RawMessage } from "./storage";

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function localDateKey(
	timestamp: number,
	groupBy: Exclude<GroupByType, "none">,
	today: Date,
	yesterday: Date,
): string {
	const date = new Date(timestamp * 1000);

	if (groupBy === "day") {
		const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
		if (dateOnly.getTime() === today.getTime()) return "Today";
		if (dateOnly.getTime() === yesterday.getTime()) return "Yesterday";
		return formatLocalDate(date);
	}

	if (groupBy === "week") {
		const dayOfWeek = date.getDay();
		const monday = new Date(date);
		monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
		return `Week of ${formatLocalDate(monday)}`;
	}

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

/**
 * Bucket raw messages by day, week, or month using their (second-based) timestamp.
 *
 * Empty / `groupBy === "none"` fall back to a single `"all"` bucket. Today /
 * Yesterday are surfaced as their own buckets first, then remaining keys are
 * sorted by descending label so the most recent bucket is always first in the
 * resulting record's iteration order.
 */
export function groupRawMessagesByPeriod(
	messages: RawMessage[],
	groupBy: GroupByType | undefined,
	now: Date = new Date(),
): Record<string, RawMessage[]> {
	if (messages.length === 0 || !groupBy || groupBy === "none") {
		return { all: messages };
	}

	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	const grouped: Record<string, RawMessage[]> = {};
	for (const message of messages) {
		const key = localDateKey(message.timestamp, groupBy, today, yesterday);
		if (!grouped[key]) grouped[key] = [];
		grouped[key].push(message);
	}

	const sortedGroups: Record<string, RawMessage[]> = {};
	const sortedKeys = Object.keys(grouped).sort((left, right) => {
		if (left === "Today") return -1;
		if (right === "Today") return 1;
		if (left === "Yesterday") return -1;
		if (right === "Yesterday") return 1;
		return right.localeCompare(left);
	});
	for (const key of sortedKeys) {
		sortedGroups[key] = grouped[key];
	}
	return sortedGroups;
}
