type LanguageSettings = {
  language?: string | null;
  languageAuto?: string | null;
};

/**
 * Resolve the effective language for agent prompts.
 *
 * Priority: explicit user setting (`language`) > auto-learned (`languageAuto`)
 * > none. The two write paths never overlap, so user changes and learning
 * cannot overwrite each other.
 */
export function resolveAgentLanguage(
  s: LanguageSettings | null | undefined,
): string | null {
  if (!s) return null;
  const explicit = (s.language ?? "").trim();
  if (explicit) return explicit;
  const auto = (s.languageAuto ?? "").trim();
  return auto || null;
}
