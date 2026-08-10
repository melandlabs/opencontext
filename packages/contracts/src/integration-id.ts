/**
 * Canonical IntegrationId enum shared between runtime (gmail, slack, discord,
 * telegram, ...) and UI (hooks, components, route handlers).
 *
 * Source of truth: this file.
 * Re-exported (for one release) by `apps/web/hooks/use-integrations.ts` for
 * backward compatibility; new code MUST import from `@openloomi/contracts`.
 *
 * The branded-type wrapper prevents accidental mixing with arbitrary strings
 * (e.g. a raw platform slug from an untrusted API response).
 */
export const INTEGRATION_IDS = [
  "telegram",
  "whatsapp",
  "slack",
  "discord",
  "gmail",
  "outlook",
  "linkedin",
  "instagram",
  "twitter",
  "google_calendar",
  "google_meet",
  "outlook_calendar",
  "teams",
  "facebook_messenger",
  "google_drive",
  "google_docs",
  "hubspot",
  "notion",
  "github",
  "asana",
  "jira",
  "linear",
  "imessage",
  "feishu",
  "dingtalk",
  "qqbot",
  "weixin",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === "string" && (INTEGRATION_IDS as readonly string[]).includes(value);
}