/** Derives an organization key (URL slug) from its display name. Pure and browser-safe: staff-web previews it. */
export function orgKeyFromName(name: string): string {
  // Staff paste names from Word: fold accents (Québec -> quebec) and delete curly apostrophes (U+2019) like straight ones.
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
