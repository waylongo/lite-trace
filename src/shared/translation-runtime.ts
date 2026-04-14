export function normalizeTranslationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
