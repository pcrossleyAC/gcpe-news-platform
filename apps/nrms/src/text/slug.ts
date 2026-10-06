const MAX_SLUG = 100;

/**
 * Legacy ReleaseManagementModel.GenerateSlug, test-for-test (Gcpe.Hub.Legacy.Website.Tests/
 * SlugUnitTests.cs): accents transliterated, curly quotes dropped, " - " → space, anything else
 * outside [a-z0-9 -] dropped, cut at 100, spaces → hyphens. May return "" (callers fall back).
 */
export function generateSlug(phrase: string): string {
  let s = phrase.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/[‘’“”]/g, "");
  s = s.replace(/ - /g, " ");
  s = s.replace(/[^a-z0-9\s-]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.slice(0, MAX_SLUG).trim();
  return s.replace(/\s/g, "-");
}
