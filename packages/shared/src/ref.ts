/**
 * Chat message inline references: parsing and serialization [[ref:type:label]]
 * Used to display inline reference badges for people/action items/channels etc. in user input and message display
 */

export const REF_MARKER_REGEX = /\[\[ref:(\w+):([^\]]*)\]\]/g;

export type InlineRefKind = "people" | "task" | "channel" | "file" | "event";

export type ContentSegment =
  | { type: "text"; value: string }
  | { type: "ref"; kind: InlineRefKind; label: string };

/**
 * Parse text with [[ref:type:label]] into paragraph array, used to render inline badges
 * Use local regex inside function to avoid state issues caused by global g flag
 */
export function parseContentWithRefs(content: string): ContentSegment[] {
  if (!content || typeof content !== "string")
    return [{ type: "text", value: content ?? "" }];
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(REF_MARKER_REGEX.source, "g");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    if (m.index > lastIndex) {
      segments.push({
        type: "text",
        value: content.slice(lastIndex, m.index),
      });
    }
    const kind = m[1] as InlineRefKind;
    const label = m[2] ?? "";
    segments.push({ type: "ref", kind, label });
    lastIndex = m.index + m[0].length;
    m = re.exec(content);
  }
  if (lastIndex < content.length) {
    segments.push({ type: "text", value: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "text", value: content }];
}

/** Match a complete [[ref:type:label]] before cursor, used for Backspace whole segment deletion */
const REF_MARKER_AT_END_REGEX = /\[\[ref:\w+:[^\]]*\]\]$/;

/**
 * If there's a complete ref marker before cursor, return its start/end indices, otherwise return null
 */
export function getRefMarkerRangeBeforeCursor(
  content: string,
  cursor: number,
): { start: number; end: number } | null {
  if (cursor <= 0) return null;
  const before = content.slice(0, cursor);
  const match = before.match(REF_MARKER_AT_END_REGEX);
  if (!match) return null;
  const start = cursor - match[0].length;
  return { start, end: cursor };
}

/**
 * Generate reference marker string to insert into input box
 */
export function buildRefMarker(kind: InlineRefKind, label: string): string {
  const safe = label.replace(/\]/g, ""); // Avoid ] inside label breaking format
  return `[[ref:${kind}:${safe}]]`;
}

/**
 * Extract all refs from message text, used to populate metadata when sending (referencedPeople / referencedTaskIds / referencedChannels / referencedContextInsightIds)
 * event's label format is id or id|title, extract id part when extracting
 */
export function extractRefsFromContent(content: string): {
  people: Array<{ name: string }>;
  taskIds: string[];
  channels: Array<{ name: string; platform?: string }>;
  eventIds: string[];
} {
  const people: Array<{ name: string }> = [];
  const taskIds: string[] = [];
  const channels: Array<{ name: string; platform?: string }> = [];
  const eventIds: string[] = [];
  REF_MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null = REF_MARKER_REGEX.exec(content);
  while (m !== null) {
    const kind = m[1];
    const label = m[2] ?? "";
    if (kind === "people") people.push({ name: label });
    else if (kind === "task")
      taskIds.push(label.startsWith("manual:") ? label : label);
    else if (kind === "channel") {
      const lastColon = label.lastIndexOf(":");
      const name = lastColon === -1 ? label : label.slice(0, lastColon);
      const platform =
        lastColon === -1 ? undefined : label.slice(lastColon + 1);
      channels.push({ name, platform });
    } else if (kind === "event") {
      const id = label.includes("|")
        ? (label.split("|")[0]?.trim() ?? label)
        : label;
      if (id && !eventIds.includes(id)) eventIds.push(id);
    }
    m = REF_MARKER_REGEX.exec(content);
  }
  return { people, taskIds, channels, eventIds };
}
