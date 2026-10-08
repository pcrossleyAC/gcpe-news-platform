/** Legacy's ReplaceSpecialCharacters (Activity.aspx.cs:1076-1087). */
export function replaceSpecialCharacters(text: string): string {
  return text
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/…/g, "...")
    .replace(/[–—]/g, "-")
    .replace(/ˆ/g, "^")
    .replace(/‹/g, "<")
    .replace(/›/g, ">")
    .replace(/[˜ ]/g, " ");
}

/** The title as legacy saved it: trimmed, each line break a space, special characters replaced. */
export function cleanTitle(title: string): string {
  return replaceSpecialCharacters(title.trim().replace(/\r/g, " ").replace(/\n/g, " "));
}

export function cleanDetails(details: string): string {
  return replaceSpecialCharacters(details.trim());
}
