/**
 * Legacy stored category names with whatever whitespace the dropdown's markup happened to have
 * (e.g. legacy category 16, "Speech /  Remarks", two spaces); the browser's rendering collapsed it,
 * so legacy never noticed. The importer copies names as they are, so a tenant config's name list
 * (a single space) must still match. Collapses every run of whitespace to one space and trims;
 * case is left exactly as given.
 */
export function normaliseCategoryName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function sameCategoryName(a: string, b: string): boolean {
  return normaliseCategoryName(a) === normaliseCategoryName(b);
}

/**
 * Whether any of `names` starts with `prefix`: legacy's Forecast and release-lookup test for an
 * "Approved" category (News/Services.asmx.cs:87, ReleasesModel.cs:155). Legacy compared in SQL
 * Server's default case-insensitive collation, so case is ignored here; whitespace is normalised
 * as {@link normaliseCategoryName} does.
 */
export function hasCategoryStartingWith(names: readonly string[], prefix: string): boolean {
  const p = normaliseCategoryName(prefix).toLowerCase();
  return names.some((n) => normaliseCategoryName(n).toLowerCase().startsWith(p));
}
