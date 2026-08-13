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

// Insight Type Tags - used to mark the type of an insight
export const INSIGHT_TYPE_TAGS = [
	"Facts", // Facts - actionable objective information
	"Patterns", // Patterns - trends and recurring findings
	"Knowledge", // Knowledge - knowledge and insights
	"Actions", // Actions - items that require follow-up
	"Observation", // Observation - noteworthy observations and findings
] as const;

// Content Tags - used to mark the source or type of content
export const CONTENT_TAGS = [
	"Marketing", // Marketing emails / promotional content
	"Contacts", // Contact-related information
	"Meetings", // Meeting-related information
	"RSVP", // Invitations that require a reply
] as const;

export type InsightTypeTag = (typeof INSIGHT_TYPE_TAGS)[number];
export type ContentTag = (typeof CONTENT_TAGS)[number];
