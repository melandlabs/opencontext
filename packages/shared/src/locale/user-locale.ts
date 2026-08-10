/**
 * Domain value object that represents a user's preferred reply language for
 * agent-facing surfaces (chat, reports, tool labels, errors).
 *
 * Why a value object instead of a raw string:
 *   - Collapses every `isChinese(language)` / `startsWith("zh")` check into a
 *     single typed surface, so adding a locale or tweaking matching rules
 *     happens in one place.
 *
 * Resolving the persistence record (the `language` / `languageAuto` priority)
 * is the job of `resolveAgentLanguage` in `lib/insights/resolve-language.ts`;
 * this value object only parses an already-resolved locale string.
 *
 * Equality is by value via `equals()`. JS reference equality is unreliable;
 * cache instances yourself if you need it.
 */

/**
 * Supported locale codes. Traditional Chinese inputs (zh-Hant, zh-TW,
 * zh-HK) currently collapse into "zh-Hans" — this matches the existing
 * prompt copy and i18n bundles. Add a dedicated code only after the prompt
 * copy and `LanguageDirectiveBuilder` learn to distinguish the two.
 */
export type LocaleCode = "zh-Hans" | "en-US";

export class UserLocale {
  readonly code: LocaleCode;

  private constructor(code: LocaleCode) {
    this.code = code;
  }

  /**
   * Product-level fallback. Picked when the user has neither a manual nor an
   * auto-learned preference. English keeps the directive English so the
   * model output is predictable for the global default.
   */
  static default(): UserLocale {
    return new UserLocale("en-US");
  }

  /**
   * Parse a raw locale string. Recognises ISO codes (`zh`, `zh-CN`,
   * `zh-Hans`, `en`, `en-US`) and short aliases. Returns null when the
   * input is empty or outside the supported set so callers can decide
   * whether to fall back to {@link UserLocale.default} or skip emitting a
   * directive entirely.
   */
  static fromString(raw: string | null | undefined): UserLocale | null {
    if (raw == null) return null;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized.startsWith("zh")) return new UserLocale("zh-Hans");
    if (normalized.startsWith("en")) return new UserLocale("en-US");
    return null;
  }

  isChinese(): boolean {
    return this.code === "zh-Hans";
  }

  isEnglish(): boolean {
    return this.code === "en-US";
  }

  /**
   * Convenience check for "is the raw locale string Chinese". Equivalent to
   * `UserLocale.fromString(raw)?.isChinese() ?? false` and exists because
   * that one-liner was duplicated across many entry points before. Prefer
   * this over calling {@link fromString} when the caller only needs a
   * boolean and is not going to hold onto the `UserLocale` instance.
   */
  static isChineseCode(raw: string | null | undefined): boolean {
    return UserLocale.fromString(raw)?.isChinese() ?? false;
  }

  /**
   * Convenience check for "is the raw locale string English". See
   * {@link isChineseCode} for rationale.
   */
  static isEnglishCode(raw: string | null | undefined): boolean {
    return UserLocale.fromString(raw)?.isEnglish() ?? false;
  }

  /**
   * Stable label used inside LLM-facing directives. Always English so the
   * directive itself is unambiguous to the model regardless of the locale
   * it is naming.
   */
  promptLabel(): string {
    switch (this.code) {
      case "zh-Hans":
        return "Simplified Chinese";
      case "en-US":
        return "English";
    }
  }

  equals(other: UserLocale | null | undefined): boolean {
    return other != null && this.code === other.code;
  }

  toString(): string {
    return this.code;
  }

  toJSON(): LocaleCode {
    return this.code;
  }
}
