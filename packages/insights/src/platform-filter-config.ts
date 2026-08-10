import type { InsightFilterCondition } from "./filter-schema";

/**
 * Structural `IntegrationId` — a string-keyed platform identifier.
 * The leaf package doesn't need the full `@opencontext/contracts/integration-id`
 * union (that lives in apps/web) to key a `Record<>` by platform. Generic
 * over the actual union keeps the type info for callers that want it.
 */
type PlatformId = string;

/**
 * Define filter condition types supported by each platform
 */
export const PLATFORM_FILTER_SUPPORT: Record<
  PlatformId,
  InsightFilterCondition["kind"][]
> = {
  // Platforms with channel/group concept
  slack: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  discord: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  telegram: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  whatsapp: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  facebook_messenger: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  teams: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  // Platforms with channel/group concept
  gmail: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  outlook: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  linkedin: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  twitter: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  instagram: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  google_drive: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  notion: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  github: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  google_docs: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  hubspot: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  google_calendar: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  google_meet: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  outlook_calendar: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  asana: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  // Project management and task tracking platforms
  jira: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  linear: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  imessage: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  feishu: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  dingtalk: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  qqbot: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
  weixin: [
    "importance",
    "urgency",
    "platform",
    "task_label",
    "account",
    "category",
    "mentions_me",
    "people",
    "groups",
    "keyword",
    "time_window",
    "has_tasks",
  ],
};

/**
 * Get all fields supported by user connected platforms
 */
export function getSupportedFilterFields(
  connectedPlatforms: PlatformId[],
): InsightFilterCondition["kind"][] {
  if (connectedPlatforms.length === 0) {
    // If no platform connected, return all fields (common fields)
    return [
      "importance",
      "urgency",
      "platform",
      "task_label",
      "account",
      "category",
      "mentions_me",
      "people",
      "groups",
      "keyword",
      "time_window",
      "has_tasks",
    ];
  }

  // Get and collect fields from all connected platforms
  const supportedFields = new Set<InsightFilterCondition["kind"]>();
  for (const platform of connectedPlatforms) {
    const fields = PLATFORM_FILTER_SUPPORT[platform] ?? [];
    for (const field of fields) {
      supportedFields.add(field);
    }
  }

  return Array.from(supportedFields);
}

/**
 * Check if a field is supported by all connected platforms
 */
export function isFieldSupportedByAllPlatforms(
  field: InsightFilterCondition["kind"],
  connectedPlatforms: PlatformId[],
): boolean {
  if (connectedPlatforms.length === 0) return true;
  return connectedPlatforms.every(
    (platform) => PLATFORM_FILTER_SUPPORT[platform]?.includes(field) ?? false,
  );
}

/**
 * Get display name of a field
 */
export function getFilterFieldLabel(
  field: InsightFilterCondition["kind"],
  t?: (key: string, defaultValue?: string) => string,
): string {
  const labels: Record<InsightFilterCondition["kind"], string> = {
    importance: "Importance",
    urgency: "Urgency",
    platform: "Platform",
    task_label: "Task Label",
    account: "Account",
    category: "Category",
    mentions_me: "Mentions Me",
    people: "People",
    groups: "Channels/Groups",
    keyword: "Keyword",
    time_window: "Time Window",
    has_tasks: "Has Tasks",
  };
  const defaultLabel = labels[field] ?? field;
  return t ? t(`insight.filter.field.${field}`, defaultLabel) : defaultLabel;
}

/**
 * Get field description
 */
export function getFilterFieldDescription(
  field: InsightFilterCondition["kind"],
  t?: (key: string, defaultValue?: string) => string,
): string {
  const descriptions: Record<InsightFilterCondition["kind"], string> = {
    importance: "Filter by importance level",
    urgency: "Filter by urgency level",
    platform: "Filter by source platform",
    task_label: "Filter by task label",
    account: "Filter by account",
    category: "Filter by category label",
    mentions_me: "Filter events mentioning @me or direct messages",
    people: "Filter by involved people",
    groups: "Filter by channel or group (not supported on some platforms)",
    keyword: "Filter by keyword (search in title, description, etc.)",
    time_window: "Filter by time range (last N hours)",
    has_tasks: "Filter by whether tasks are included",
  };
  const defaultDesc = descriptions[field] ?? "";
  return t ? t(`insight.filter.fieldDesc.${field}`, defaultDesc) : defaultDesc;
}
