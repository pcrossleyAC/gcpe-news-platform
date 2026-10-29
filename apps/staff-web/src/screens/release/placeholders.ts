import { LANGUAGE_NAME, type ReleaseView } from "@gcpe/nrms-contract";

/**
 * Placeholder text an editor leaves for later ("to come", "TBD", "TBC", "XX", "[insert …]"),
 * matched case-insensitively. Owner decision 2026-10-29: Approve warns about these (it doesn't
 * block — "to come" is also ordinary English), listing each so the editor can find it. TBD/TBC/XX
 * are whole words only, so "Exxon" or "TBDX" don't match; XX also matches XXX, XX,XXX etc.
 */
const PLACEHOLDER = /\bto come\b|\bTBD\b|\bTBC\b|\bX{2,}\b|\[insert/gi;

/** Characters of context shown on each side of a hit. */
const CONTEXT = 30;

export interface PlaceholderHit {
  /** Where it is, in the words the editor sees ("Document 1 (English) body"). */
  where: string;
  /** The placeholder as written. */
  text: string;
  /** The hit with some text around it, "…" marking where the field goes on. */
  context: string;
}

const BLOCK_TAG = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|blockquote|table)\b[^>]*>/gi;

/** Body HTML as the reader sees it: block tags become spaces, others vanish, entities decode. */
function htmlText(html: string): string {
  const flat = html.replace(BLOCK_TAG, " ").replace(/<[^>]*>/g, "");
  const doc = new DOMParser().parseFromString(`<body>${flat}</body>`, "text/html");
  return doc.body.textContent ?? "";
}

function hitsIn(where: string, raw: string | null | undefined): PlaceholderHit[] {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: PlaceholderHit[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const start = m.index;
    const end = start + m[0].length;
    // Widened to whole words: cut at a space inside the window, never mid-word.
    let from = Math.max(0, start - CONTEXT);
    if (from > 0) {
      const space = text.indexOf(" ", from);
      from = space !== -1 && space < start ? space + 1 : start;
    }
    let to = Math.min(text.length, end + CONTEXT);
    if (to < text.length) {
      const space = text.lastIndexOf(" ", to);
      to = space >= end ? space : end;
    }
    const context = `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
    out.push({ where, text: m[0], context });
  }
  return out;
}

/** Every placeholder in the release's text (summary, location and each document language), in page order. */
export function placeholderHits(view: ReleaseView): PlaceholderHit[] {
  const out: PlaceholderHit[] = [];
  for (const l of view.languages) {
    const lang = LANGUAGE_NAME[l.languageId];
    out.push(...hitsIn(`Location (${lang})`, l.location));
    out.push(...hitsIn(`Summary (${lang})`, l.summary));
    out.push(...hitsIn(`Social media summary (${lang})`, l.socialMediaSummary));
  }
  for (const d of [...view.documents].sort((a, b) => a.sortIndex - b.sortIndex)) {
    for (const l of d.languages) {
      const label = `Document ${d.sortIndex + 1} (${LANGUAGE_NAME[l.languageId]})`;
      out.push(...hitsIn(`${label} page title`, l.pageTitle));
      out.push(...hitsIn(`${label} headline`, l.headline));
      out.push(...hitsIn(`${label} subheadline`, l.subheadline));
      out.push(...hitsIn(`${label} organizations`, l.organizations));
      out.push(...hitsIn(`${label} byline`, l.byline));
      out.push(...hitsIn(`${label} body`, htmlText(l.bodyHtml)));
      l.contacts.forEach((c, i) => out.push(...hitsIn(`${label} contact ${i + 1}`, c)));
    }
  }
  return out;
}
