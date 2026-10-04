import { htmlToText } from "./html-to-text";

/** Legacy Release.ToTextDocumentAsString punctuation table. */
const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚]/g, "'"],
  [/[“”„]/g, '"'],
  [/…/g, "..."],
  [/[‒–—―]/g, "-"],
  [/⁓/g, "~"],
  [/[_ˍ]/g, "_"],
  [/[-­¯ˉ˗‐‑‾⁃⁻₋−⎯⏤─➖⸺⸻မ]/g, "-"],
  [/[~˜∼]/g, "~"],
  [/ˆ/g, "^"],
  [/‹/g, "<"],
  [/›/g, ">"],
  [/[˜ ]/g, " "],
];

export function asciiPunctuation(s: string): string {
  return REPLACEMENTS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

export function collapseBlankLines(s: string): string {
  let out = s;
  while (out.includes("\r\n\r\n\r\n") || out.includes("\r\n  \r\n")) out = out.replaceAll("\r\n\r\n\r\n", "\r\n\r\n").replaceAll("\r\n  \r\n", "\r\n\r\n");
  return out;
}

/** Legacy Utils.TrimSummary. */
export function trimSummary(text: string, length = 500): string {
  if (text.length <= length) return text;
  let s = text.slice(0, length - 3);
  while (s.length > 0 && !/[ .!?]$/.test(s)) s = s.slice(0, -1);
  s = s.trim();
  if (!/[.!?]$/.test(s)) {
    if (/\p{P}$/u.test(s)) s = s.slice(0, -1);
    s = s.trim() + "...";
  }
  return s;
}

/** Legacy NewModel.TidyAndTruncateDocumentBodyText over Convert.HtmlToText: the first line. */
export function ledeFromBody(html: string): string {
  const text = htmlToText(html).replaceAll("\r", "");
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

export function summaryFromBody(html: string): string {
  return trimSummary(ledeFromBody(html), 500);
}
