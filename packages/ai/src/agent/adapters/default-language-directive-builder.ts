/**
 * Default LanguageDirectiveBuilder used by every agent entry point.
 *
 * This is the single converged copy for "tell the model what language to
 * reply in". When any new locale, channel, or wording change is needed,
 * make it here once. Industry consensus (Anthropic, OpenAI prompting
 * guides, MCP/A2A schema-validated context) is that the directive's
 * wording matters less than carrying the locale as a typed, propagated
 * field; this adapter relies on the typed `UserLocale` for correctness and
 * uses stable, direct copy rather than escalating to "MUST" / "Language
 * Lock" theatrics.
 *
 * The conversational and artifact channels are kept distinct so future
 * product decisions ("chat in zh, report in en") can be expressed without
 * rewriting downstream code.
 */

import type { UserLocale } from "@openloomi/shared";

import type {
  DirectiveChannel,
  LanguageDirectiveBuilder,
} from "../ports/language-directive.port";

export class DefaultLanguageDirectiveBuilder implements LanguageDirectiveBuilder {
  buildDirective(locale: UserLocale | null, channel: DirectiveChannel): string {
    if (locale == null) return "";

    const label = locale.promptLabel();

    if (channel === "conversational") {
      return [
        "",
        "",
        "**Language Preference**:",
        `Reply to the user in ${label}. Tool names and inline labels shown to the user should use the same language. Internal reasoning may stay in any language; only the user-facing reply is locked.`,
        "",
      ].join("\n");
    }

    return [
      "",
      "",
      "**Artifact Language**:",
      `When writing report files (.md / .txt / .rtf) or other generated documents, use ${label}. Apply this to headings, body paragraphs, tables, and inline labels.`,
      "",
    ].join("\n");
  }
}

/**
 * Module-level singleton. The builder is stateless; sharing one instance
 * avoids the noise of constructing it at every call site.
 */
export const defaultLanguageDirectiveBuilder: LanguageDirectiveBuilder =
  new DefaultLanguageDirectiveBuilder();
