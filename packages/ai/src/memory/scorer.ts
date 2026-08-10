import type { MemoryRecord, MemoryRecordScorer } from "./contracts";

const IMPORTANCE_KEYWORDS = [
  "deadline",
  "todo",
  "urgent",
  "risk",
  "decision",
  "blocker",
  "meeting",
  "action item",
  "milestone",
  "bug",
  "incident",
  "follow up",
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferImportanceFromText(text: string | undefined): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }
  const lower = text.toLowerCase();
  const hits = IMPORTANCE_KEYWORDS.filter((keyword) =>
    lower.includes(keyword),
  ).length;
  // Cap inference noise quickly.
  return clamp01(hits / 4);
}

/**
 * Default scorer for progressive forgetting.
 *
 * Score range: [0, 1], where higher = higher retention priority.
 */
export class DefaultMemoryRecordScorer implements MemoryRecordScorer {
  score(record: MemoryRecord, context: { now: number }): number {
    const ageMs = Math.max(0, context.now - record.timestamp);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    const recencyScore = clamp01(1 - ageMs / (6 * thirtyDaysMs));

    const accessCount = record.accessCount ?? 0;
    const accessScore = clamp01(Math.log1p(accessCount) / Math.log(10));

    const providedImportance = record.importanceScore ?? 0;
    const inferredImportance = inferImportanceFromText(record.text);
    const importanceScore = clamp01(
      Math.max(providedImportance, inferredImportance),
    );

    const mediaScore =
      record.mediaRefs && record.mediaRefs.length > 0 ? 0.7 : 0.25;

    const pinnedBoost = record.isPinned ? 0.3 : 0;

    return clamp01(
      0.35 * recencyScore +
        0.3 * accessScore +
        0.25 * importanceScore +
        0.1 * mediaScore +
        pinnedBoost,
    );
  }
}
