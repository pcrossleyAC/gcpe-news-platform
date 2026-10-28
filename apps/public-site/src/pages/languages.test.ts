import { describe, expect, it } from "vitest";
import { TRANSLATION_LANGUAGES, translationLanguage } from "./languages";

describe("translationLanguage (legacy ToDefaultTranslationLanguage)", () => {
  it("maps Chinese(Simplified) and Chinese_Simplified to 简体中文 zh-Hans; Punjabi to ਪੰਜਾਬੀ pa; unknown keeps the label; null is 'View translation'", () => {
    expect(translationLanguage("Chinese(Simplified)")).toEqual({ name: "简体中文", lang: "zh-Hans" });
    expect(translationLanguage("2026HLTH0001_Chinese_Simplified.pdf")).toEqual({ name: "简体中文", lang: "zh-Hans" });
    expect(translationLanguage("PUNJABI")).toEqual({ name: "ਪੰਜਾਬੀ", lang: "pa" });
    expect(translationLanguage("Klingon")).toEqual({ name: "Klingon", lang: null });
    expect(translationLanguage(null)).toEqual({ name: "View translation", lang: null });
    expect(translationLanguage("  ")).toEqual({ name: "View translation", lang: null });
  });

  it("carries legacy's 25 keys, each with a BCP 47 tag; the last match wins, as legacy's loop does", () => {
    expect(TRANSLATION_LANGUAGES).toHaveLength(25);
    for (const [, , tag] of TRANSLATION_LANGUAGES) expect(tag).toMatch(/^[a-z]{2}(-[A-Z][a-z]{3})?$/);
    // "French" then "Spanish": Spanish comes later in the table, so it wins.
    expect(translationLanguage("French-Spanish")).toEqual({ name: "Español", lang: "es" });
  });
});
