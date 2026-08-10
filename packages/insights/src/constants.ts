export const DEBUG = process.env.DEBUG_WHATSAPP === "true";

export const EMAIL_TASK_LABEL = "gmail_email";
export const MAX_EMAIL_INSIGHTS = 200;
export const CALENDAR_TASK_LABEL = "calendar_event";
export const CALENDAR_UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1000;

// Concurrency control constants
export const DEFAULT_GROUP_CONCURRENCY = 3; // Default concurrent group processing count
export const MAX_GROUP_CONCURRENCY = 5; // Maximum concurrency
export const MIN_GROUP_CONCURRENCY = 1; // Minimum concurrency

// Default categories list
export const DEFAULT_CATEGORIES = [
  "News",
  "Meetings",
  "Funding",
  "R&D",
  "Partnerships",
  "User Growth",
  "Branding",
  "Marketing",
  "HR & Recruiting",
];

// Insight Type Tags - 用于标记 insight 的类型
export const INSIGHT_TYPE_TAGS = [
  "Facts", // 事实 - 可操作的客观信息
  "Patterns", // 规律 - 趋势、规律性发现
  "Knowledge", // 认知 - 知识、见解
  "Actions", // 行动 - 需要采取行动的事项
  "Observation", // 观察 - 值得注意的观察和发现
] as const;

// Content Tags - 用于标记内容来源或类型
export const CONTENT_TAGS = [
  "Marketing", // 营销邮件/促销内容
  "Contacts", // 联系人相关信息
  "Meetings", // 会议相关信息
  "RSVP", // 需要回复的邀请
] as const;

export type InsightTypeTag = (typeof INSIGHT_TYPE_TAGS)[number];
export type ContentTag = (typeof CONTENT_TAGS)[number];
