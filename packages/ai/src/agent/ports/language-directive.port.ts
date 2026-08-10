/**
 * Builds the natural-language directive that tells an LLM which language to
 * use for a particular output surface.
 *
 * Two channels are recognised:
 *   - "conversational": chat replies, tool labels visible to the user,
 *     error messages, and any other text the user reads inline.
 *   - "artifact": generated files such as Markdown reports, plain-text
 *     notes, or other deliverables the user opens separately.
 *
 * The same locale can produce different copy per channel, which is why
 * callers must always pass the channel explicitly. Returning the empty
 * string when the locale is null lets callers stay locale-agnostic at the
 * call site.
 */

import type { UserLocale } from "@openloomi/shared";

export type DirectiveChannel = "conversational" | "artifact";

export interface LanguageDirectiveBuilder {
  buildDirective(locale: UserLocale | null, channel: DirectiveChannel): string;
}
