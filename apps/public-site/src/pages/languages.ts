/**
 * Legacy `NewsroomExtensions.ToDefaultTranslationLanguage`'s table (Gov.News.WebApp, Apache-2.0):
 * a translation file's label → the language's own name, here with its BCP 47 tag so the link can
 * carry `lang`/`hreflang`. Kept in legacy's order: the lookup keeps the *last* key the label
 * contains, as legacy's loop does.
 */
export const TRANSLATION_LANGUAGES: readonly (readonly [key: string, name: string, lang: string])[] = [
  ["Arabic", "عربى", "ar"],
  ["Chinese_Simplified", "简体中文", "zh-Hans"],
  ["Chinese(Simplified)", "简体中文", "zh-Hans"],
  ["Chinese_Traditional", "繁體中文", "zh-Hant"],
  ["Chinese(Traditional)", "繁體中文", "zh-Hant"],
  ["Dutch", "Nederlands", "nl"],
  ["Farsi", "فارسی", "fa"],
  ["Finnish", "Suomi", "fi"],
  ["French", "Français", "fr"],
  ["Gujarati", "ગુજરાતી", "gu"],
  ["Hebrew", "עִברִית", "he"],
  ["Hindi", "हिंदी", "hi"],
  ["Indonesian", "bahasa Indonesia", "id"],
  ["Japanese", "日本語", "ja"],
  ["Korean", "한국어", "ko"],
  ["Portuguese", "Português", "pt"],
  ["Punjabi", "ਪੰਜਾਬੀ", "pa"],
  ["Russian", "Русский", "ru"],
  ["Somali", "Soomaali", "so"],
  ["Spanish", "Español", "es"],
  ["Swahili", "Kiswahili", "sw"],
  ["Tagalog", "Tagalog", "tl"],
  ["Ukrainian", "Українська", "uk"],
  ["Urdu", "اردو", "ur"],
  ["Vietnamese", "Tiếng Việt", "vi"],
];

/**
 * The language a translation's label names: legacy's case-insensitive "label contains key" match,
 * last match winning. With no match the label itself is the name (legacy showed "View
 * translation" for every unknown label; the label says more) and there is no tag; with no label,
 * "View translation" — so is a blank label, which would otherwise leave a nameless link.
 */
export function translationLanguage(label: string | null): { name: string; lang: string | null } {
  const lower = (label ?? "").toLowerCase();
  let found: { name: string; lang: string | null } | null = null;
  for (const [key, name, lang] of TRANSLATION_LANGUAGES) if (lower.includes(key.toLowerCase())) found = { name, lang };
  return found ?? { name: label?.trim() || "View translation", lang: null };
}
