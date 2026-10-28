/** A publish time as the history and publish bar show it, in the tenant time zone: "Oct 27, 2026, 11:00 AM". */
export function formatPublishedAt(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Paragraphs holding nothing visible: what the rich-text editor leaves when its box is cleared. */
const EMPTY_PARAGRAPHS = /^(?:\s*<p>(?:\s|&nbsp;| |<br\s*\/?>)*<\/p>)*\s*$/i;

/** A cleared rich-text box (the editor's `<p></p>`) as "", so the public page shows no empty
 * paragraph and the field reads as empty; anything else unchanged. */
export function blankIfEmptyHtml(html: string): string {
  return EMPTY_PARAGRAPHS.test(html) ? "" : html;
}
