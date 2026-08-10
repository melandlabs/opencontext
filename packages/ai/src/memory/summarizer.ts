import type {
  MemoryGroup,
  MemorySummarizer,
  MemorySummaryDraft,
} from "./contracts";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "was",
  "were",
  "you",
  "your",
  "our",
  "are",
  "not",
  "but",
  "about",
  "into",
  "then",
  "than",
  "when",
  "where",
  "what",
  "which",
  "would",
  "could",
  "should",
  "will",
  "can",
  "just",
  "been",
  "also",
]);

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function sliceLine(input: string, maxLength: number): string {
  const normalized = normalizeWhitespace(input);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function extractKeywords(texts: string[], maxCount: number): string[] {
  const scores = new Map<string, number>();
  for (const text of texts) {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
    for (const word of words) {
      scores.set(word, (scores.get(word) ?? 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([word]) => word);
}

function timestampToIsoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class RuleBasedMemorySummarizer implements MemorySummarizer {
  async summarizeGroup(group: MemoryGroup): Promise<MemorySummaryDraft> {
    const sortedRecords = [...group.records].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    const texts = sortedRecords
      .map((record) => record.text ?? "")
      .map((text) => normalizeWhitespace(text))
      .filter((text) => text.length > 0);

    const keyPoints = texts
      .slice(0, 5)
      .map((text) => sliceLine(text, 180))
      .filter((value, index, array) => array.indexOf(value) === index);

    const keywords = extractKeywords(texts, 12);
    const start = timestampToIsoDay(group.startTimestamp);
    const end = timestampToIsoDay(group.endTimestamp);

    const summaryText = [
      `Window: ${start} -> ${end}`,
      `Tier transition: ${group.sourceTier} -> ${group.targetTier} (${group.summaryTier})`,
      `Records: ${group.records.length}`,
      keyPoints.length > 0
        ? `Highlights: ${keyPoints.join(" | ")}`
        : "Highlights: (no text content, likely attachment-driven records)",
    ].join("\n");

    return {
      summaryText,
      keyPoints,
      keywords,
      qualityScore: keyPoints.length > 0 ? 0.75 : 0.45,
    };
  }
}
