import { getDocumentProxy } from "unpdf";

/** One page of a PDF as a reader meets it: its size, its lines top to bottom, and its links. */
export interface PdfPage {
  /** Points: [width, height]. */
  size: [number, number];
  lines: { y: number; text: string }[];
  links: { y: number; url: string }[];
}

/** The text of every page, cells on one baseline joined into one line, with unpdf (pdf.js, no native code). */
export async function pdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pages: PdfPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const byLine = new Map<number, { x: number; s: string }[]>();
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item) || !item.str) continue;
      const y = Math.round(item.transform[5] as number);
      const key = [...byLine.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      byLine.set(key, [...(byLine.get(key) ?? []), { x: item.transform[4] as number, s: item.str }]);
    }
    const lines = [...byLine]
      .sort(([a], [b]) => b - a)
      .map(([y, items]) => ({ y, text: items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim() }))
      .filter((l) => l.text);
    const links = ((await page.getAnnotations()) as { subtype?: string; url?: string; rect?: number[] }[])
      .filter((a) => a.subtype === "Link" && typeof a.url === "string")
      .map((a) => ({ y: Math.round(a.rect![3]!), url: a.url! }));
    pages.push({ size: [Math.round(x1 - x0), Math.round(y1 - y0)], lines, links });
  }
  return pages;
}

const SECTIONS = ["inside government", "outside government", "events, speeches & releases", "issues and reports", "consultations and dialogues", "in the news", "awareness dates", "long term outlook", "30 / 60 / 90 report"];
const DAY = /^(No Activities for )?((?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, [A-Z][a-z]+ \d{1,2}, \d{4})$/;
const MONTH = /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
/** An activity's link: ours (/hub/calendar/activities/123) or legacy's (Activity.aspx?ActivityId=123). */
const ACTIVITY_LINK = /(?:\/hub\/calendar\/activities\/|[?&]ActivityId=)(\d+)$/;

/**
 * A report's structure in reading order, for golden tests and the 5i comparison with legacy's
 * PDFs: "§ SECTION", "# day or month heading", "∅ day with no activities", and "id:123" for each
 * row's activity link. The cover (the page with "Contents:") is skipped.
 */
export function outlineOf(pages: PdfPage[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    if (page.lines.some((l) => l.text === "Contents:")) continue;
    const tokens: { y: number; t: string }[] = [];
    for (const l of page.lines) {
      const day = DAY.exec(l.text);
      if (SECTIONS.includes(l.text.toLowerCase())) tokens.push({ y: l.y, t: `§ ${l.text.toUpperCase()}` });
      else if (day) tokens.push({ y: l.y, t: `${day[1] ? "∅" : "#"} ${day[2]}` });
      else if (MONTH.test(l.text)) tokens.push({ y: l.y, t: `# ${l.text}` });
    }
    for (const link of page.links) {
      const m = ACTIVITY_LINK.exec(link.url);
      if (m) tokens.push({ y: link.y, t: `id:${m[1]}` });
    }
    out.push(...tokens.sort((a, b) => b.y - a.y).map((x) => x.t));
  }
  return out;
}
