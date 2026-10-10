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
