import { inArray } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import { lists, type ItemRow } from "./db/schema";

/** What a render function needs about one item — a subset of `items` plus its resolved
 * category names/urls (see {@link itemCategories}). */
export type RenderItem = Pick<ItemRow, "key" | "title" | "summary" | "url" | "publishedAt"> & {
  categories: { name: string; url: string | null }[];
};

/** `siteUrl`: the public site home, linked as "See more from BC Gov News" in every footer.
 * `bannerUrl`: optional (env `NOD_BANNER_URL`) — when set, the banner is an `<img>`; otherwise
 * a plain blue heading stands in for it (legacy's `Site.BannerSource`, which this deployment
 * doesn't have an equivalent asset host for yet). */
export type RenderOptions = { siteUrl: string; bannerUrl: string | null };

export type Rendered = { subject: string; html: string; text: string };

/**
 * Distribution (Task 7) substitutes `{{name}}` placeholders in a single pass over the final
 * html/text, after this module has done its own escaping — so an escaped "{{manageUrl}}"
 * sitting in release text would still read as a live placeholder to Distribution's regex.
 * Breaking up every pair of adjacent braces stops that match, while the one REAL
 * `{{manageUrl}}`/`{{unsubscribeUrl}}` placeholders — the footer links below — are untouched.
 *
 * P2-R25 item 2: *every* `{` next to another `{` is broken up — not each `{{` match once, which
 * let `{{{manageUrl}}` through as `{ {{manageUrl}}` — so the output never contains `{{` at all,
 * and running it again changes nothing (idempotent). In html, each `{` that follows a `{`
 * becomes the entity `&#123;` (renders identically); in text, each `{` followed by a `{` gets a
 * space after it. Exported for tests.
 */
export const neutralizeHtml = (s: string): string => escapeHtml(s).replace(/(?<=\{)\{/g, "&#123;");
export const neutralizeText = (s: string): string => s.replace(/\{(?=\{)/g, "{ ");

// Distribution rejects (400, terminal) a subject containing CR/LF or longer than
// 998 characters (apps/distribution/src/messages.ts's `z.string().max(998)`, which — like
// every JS/zod string length check — counts UTF-16 *code units*, not Unicode code points) —
// and a raw title can be either (a release imported with embedded newlines, or simply a very
// long one, including one made of astral-plane characters that are 2 units each). A terminal
// 400 at that layer means nobody gets mailed, so the subject is sanitised here, before it ever
// reaches Distribution.
const MAX_SUBJECT_UTF16_UNITS = 998;

/**
 * Truncates `s` to at most `maxUnits` UTF-16 code units (matching how Distribution's own
 * `z.string().max(998)` measures length), appending "…" when truncation actually happens —
 * without ever splitting a surrogate pair. `string.slice(0, n)` counts units already (unlike
 * `Array.from`, which counts code points — the wrong measure here, since a 600-character
 * string of astral emoji is 600 code points but 1200 UTF-16 units, well over the real limit).
 * The one hazard `slice` alone doesn't guard against: landing exactly between a surrogate
 * pair's two halves, which would store a dangling lone high surrogate — checked for and, if
 * so, the whole pair is dropped instead of just its first half.
 */
function truncateByUtf16Units(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) return s;
  let end = maxUnits - 1; // room for the trailing "…" (1 unit)
  const codeBefore = s.charCodeAt(end - 1);
  if (codeBefore >= 0xd800 && codeBefore <= 0xdbff) end -= 1; // would split a surrogate pair — drop it whole
  return s.slice(0, end) + "…";
}

/**
 * Collapses all whitespace (including \r\n\t, which would otherwise smuggle extra header
 * lines into the SMTP Subject header) to single spaces, trims, neutralises `{{` the same way
 * the text body does (so an item whose text happens to contain `{{manageUrl}}` isn't
 * substituted by Distribution), and truncates to {@link MAX_SUBJECT_UTF16_UNITS}. Falls back to
 * `fallback` when, after trimming, `raw` turns out to have been empty or whitespace-only — a
 * subject must never be empty (Distribution's schema requires at least 1 character).
 */
function sanitizeSubject(raw: string, fallback: string): string {
  const cleaned = neutralizeText(raw.replace(/\s+/g, " ").trim());
  const base = cleaned.length > 0 ? cleaned : fallback;
  return truncateByUtf16Units(base, MAX_SUBJECT_UTF16_UNITS);
}

/** Global constraints: "`<prefix> - <title>`". Controller ruling: an empty or
 * whitespace-only title still gets the prefix — the fallback is `<prefix> - <key>`
 * (e.g. "BC Gov News - 2026CITZ0001-000004"), not the bare key alone. */
function subjectFor(prefix: string, item: RenderItem): string {
  const title = item.title.replace(/\s+/g, " ").trim();
  const raw = `${prefix} - ${title || item.key}`;
  return sanitizeSubject(raw, raw);
}

function categoryLineHtml(categories: { name: string; url: string | null }[]): string {
  return categories
    .map((c) => (c.url ? `<a href="${escapeHtml(c.url)}" style="color:#666666;text-decoration:underline;">${neutralizeHtml(c.name)}</a>` : neutralizeHtml(c.name)))
    .join(", ");
}

function categoryLineText(categories: { name: string; url: string | null }[]): string {
  return categories.map((c) => neutralizeText(c.name)).join(", ");
}

const SUMMARY_STYLE = "margin:0 0 8px;font-size:14px;color:#333333;";

/** A release's summary is one paragraph, as it always was. An emergency alert carries its whole
 * text, so its blank-line paragraphs and line breaks are kept. */
function summaryHtml(summary: string, paragraphs: boolean): string {
  if (!paragraphs) return `<p style="${SUMMARY_STYLE}">${neutralizeHtml(summary)}</p>`;
  return summary
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p style="${SUMMARY_STYLE}">${neutralizeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** One item's block: title (bold blue link), summary paragraph(s), "▶ READ MORE" link, then the
 * grey category line — the shared layout behind the real legacy digest sample (both for one
 * item, used by As-It-Happens/emergency, and repeated per item in the digest). `paragraphs`
 * (emergency only) keeps the summary's blank-line paragraphs and line breaks instead of
 * collapsing it to one `<p>`. */
function itemBlockHtml(item: RenderItem, paragraphs = false): string {
  const categoriesLine = categoryLineHtml(item.categories);
  return (
    `<tr><td style="padding:16px 24px;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 8px;"><a href="${escapeHtml(item.url)}" style="color:#1a5a96;font-weight:bold;font-size:18px;text-decoration:underline;">${neutralizeHtml(item.title)}</a></p>` +
    summaryHtml(item.summary, paragraphs) +
    `<p style="margin:0 0 8px;"><a href="${escapeHtml(item.url)}" style="color:#1a5a96;font-weight:bold;font-size:12px;text-decoration:underline;text-transform:uppercase;">▶ READ MORE</a></p>` +
    (categoriesLine ? `<p style="margin:0;font-size:12px;color:#666666;">${categoriesLine}</p>` : "") +
    `</td></tr>`
  );
}

function itemBlockText(item: RenderItem): string {
  const categoriesLine = categoryLineText(item.categories);
  const lines = [neutralizeText(item.title), neutralizeText(item.summary), `Read more: ${item.url}`];
  if (categoriesLine) lines.push(categoriesLine);
  return lines.join("\n\n");
}

function bannerHtml(opts: RenderOptions): string {
  return opts.bannerUrl
    ? `<tr><td><img src="${escapeHtml(opts.bannerUrl)}" alt="Government of B.C. News on Demand" width="600" style="display:block;width:100%;max-width:600px;border:0;"></td></tr>`
    : `<tr><td style="background-color:#003366;color:#ffffff;padding:16px 24px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;">Government of B.C. — News on Demand</td></tr>`;
}
const BANNER_TEXT = "Government of B.C. — News on Demand";

type FooterKind = "subscriber" | "system";

/** Footer bar (global constraints / the real legacy samples): a subscriber email's grey bar has
 * two cells ("Manage your subscription" → `{{manageUrl}}`, "See more from BC Gov News" →
 * siteUrl), "Please do not respond to this message", then a small "Unsubscribe" link →
 * `{{unsubscribeUrl}}` (C62 — legacy had none in the body). A system email's bar (manage/verify/
 * change-email — not a subscriber send) has only the one "See more" cell, and no unsubscribe
 * link at all (manage-email-2026-09-24.md). */
function footerHtml(opts: RenderOptions, kind: FooterKind): string {
  const seeMoreCell = `<td style="padding:8px 24px;text-align:${kind === "subscriber" ? "right" : "center"};font-family:Arial,Helvetica,sans-serif;font-size:12px;"><a href="${escapeHtml(opts.siteUrl)}" style="color:#333333;">See more from BC Gov News</a></td>`;
  const manageCell =
    kind === "subscriber"
      ? `<td style="padding:8px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;"><a href="{{manageUrl}}" style="color:#333333;">Manage your subscription</a></td>`
      : "";
  const bar = `<tr><td style="background-color:#eeeeee;padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${manageCell}${seeMoreCell}</tr></table></td></tr>`;
  const doNotRespond = `<tr><td style="padding:12px 24px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666666;">Please do not respond to this message</td></tr>`;
  const unsubscribe =
    kind === "subscriber"
      ? `<tr><td style="padding:0 24px 16px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;"><a href="{{unsubscribeUrl}}" style="color:#999999;">Unsubscribe</a></td></tr>`
      : "";
  return bar + doNotRespond + unsubscribe;
}

function footerText(opts: RenderOptions, kind: FooterKind): string {
  const lines: string[] = [];
  if (kind === "subscriber") lines.push("Manage your subscription: {{manageUrl}}");
  lines.push(`See more from BC Gov News: ${opts.siteUrl}`);
  lines.push("Please do not respond to this message.");
  if (kind === "subscriber") lines.push("Unsubscribe: {{unsubscribeUrl}}");
  return lines.join("\n");
}

/** Table-based layout, inline styles only (email clients ignore `<style>`), max width 600px —
 * `bodyRowsHtml` is one or more already-built `<tr>` row(s) (an item block, or a system email's
 * own single wrapped row). */
function shellHtml(opts: RenderOptions, bodyRowsHtml: string, footer: FooterKind): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">` +
    bannerHtml(opts) +
    bodyRowsHtml +
    footerHtml(opts, footer) +
    `</table>`
  );
}

function shellText(opts: RenderOptions, bodyText: string, footer: FooterKind): string {
  return `${BANNER_TEXT}\n\n${bodyText}\n\n${footerText(opts, footer)}`;
}

/** Shared shell for system emails (verify/manage/change-email — apps/nod/src/subscribe/emails.ts's
 * `renderSystemEmail`): the same banner, wrapping `bodyHtml`/`bodyText` (the heading, lines and
 * action link that module already builds), with the one-cell "See more from BC Gov News" footer
 * and no manage/unsubscribe cell — these aren't subscriber sends. */
export function renderSystemShell(opts: RenderOptions, bodyHtml: string, bodyText: string): { html: string; text: string } {
  const row = `<tr><td style="padding:16px 24px;font-family:Arial,Helvetica,sans-serif;">${bodyHtml}</td></tr>`;
  return { html: shellHtml(opts, row, "system"), text: shellText(opts, bodyText, "system") };
}

export function renderAsItHappens(item: RenderItem, opts: RenderOptions): Rendered {
  return {
    subject: subjectFor("BC Gov News", item),
    html: shellHtml(opts, itemBlockHtml(item), "subscriber"),
    text: shellText(opts, itemBlockText(item), "subscriber"),
  };
}

export function renderEmergency(item: RenderItem, opts: RenderOptions): Rendered {
  return {
    subject: subjectFor("Emergency Info BC", item),
    html: shellHtml(opts, itemBlockHtml(item, true), "subscriber"),
    text: shellText(opts, itemBlockText(item), "subscriber"),
  };
}

/** Legacy media-advisory convention: a line reading exactly `MEDIA ADVISORY - EVENT REMINDER`
 * is immediately followed by the event's own headline, repeated -- which the media copy must
 * not show a second time. */
const MEDIA_ADVISORY_REMINDER_LINE = "MEDIA ADVISORY - EVENT REMINDER";

const MEDIA_FONT = "'BC Sans', Arial, Helvetica, sans-serif";

/** Normalises line endings to `\n` and, for an advisory, drops the lines immediately following
 * a {@link MEDIA_ADVISORY_REMINDER_LINE} up to (not including) the next blank line. */
function normalizeMediaText(mediaText: string, postKind: string | null): string {
  const normalized = mediaText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (postKind !== "advisories") return normalized;
  const lines = normalized.split("\n");
  const idx = lines.findIndex((l) => l.trim() === MEDIA_ADVISORY_REMINDER_LINE);
  if (idx === -1) return normalized;
  let end = idx + 1;
  while (end < lines.length && lines[end]!.trim() !== "") end++;
  return [...lines.slice(0, idx + 1), ...lines.slice(end)].join("\n");
}

/** Splits `text` on blank lines into paragraphs, HTML-escaping each and turning its own single
 * newlines into `<br>` (global constraints: media body layout). */
function mediaParagraphsHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p style="margin:0 0 16px;">${neutralizeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function readMoreHtml(url: string): string {
  return `<p style="margin:0 0 16px;"><a href="${escapeHtml(url)}" style="color:#1a5a96;font-weight:bold;text-decoration:underline;">▶ READ MORE</a></p>`;
}

function categoriesBlockHtml(categories: { name: string; url: string | null }[]): string {
  const line = categoryLineHtml(categories);
  return line ? `<p style="margin:0;font-size:12px;color:#666666;">${line}</p>` : "";
}

/** Bare title for an advisory (`postKind === 'advisories'`), else `BC Gov News - <title>` —
 * global constraints' media subject rule. Sanitised (and falls back to the item key) the same
 * way every other subject is. */
function subjectForMedia(item: RenderItem & { postKind: string | null }): string {
  if (item.postKind === "advisories") {
    const title = item.title.replace(/\s+/g, " ").trim();
    return sanitizeSubject(title, item.key);
  }
  return subjectFor("BC Gov News", item);
}

/**
 * The media-list version of an item: no banner (legacy media look), BC Sans at 18px, the
 * release's full text as paragraphs, then "▶ READ MORE" (omitted for an advisory), then the
 * grey topic line (already excludes media lists -- `item.categories` is resolved from
 * `items.listKeys`, which never carries a media key), then 4b's standard subscriber footer
 * (manage/see-more/do-not-respond/unsubscribe) -- global constraints, "Media emails".
 */
export function renderMedia(item: RenderItem & { mediaText: string; postKind: string | null }, opts: RenderOptions): Rendered {
  const isAdvisory = item.postKind === "advisories";
  const text = normalizeMediaText(item.mediaText, item.postKind);

  const bodyHtml =
    `<tr><td style="padding:16px 24px;font-family:${MEDIA_FONT};font-size:18px;color:#000000;">` +
    mediaParagraphsHtml(text) +
    (isAdvisory ? "" : readMoreHtml(item.url)) +
    categoriesBlockHtml(item.categories) +
    `</td></tr>`;

  // The text part must be neutralised too (every other renderer's own text part is) -- a media
  // body containing a literal "{{unsubscribeUrl}}" or "{{manageUrl}}" would otherwise read as a
  // live placeholder to Distribution's substitution pass, handing every recipient someone
  // else's (or no one's) real link.
  const bodyTextLines = [neutralizeText(text)];
  if (!isAdvisory) bodyTextLines.push(`Read more: ${item.url}`);
  const categoriesLine = categoryLineText(item.categories);
  if (categoriesLine) bodyTextLines.push(categoriesLine);

  return {
    subject: subjectForMedia(item),
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">${bodyHtml}${footerHtml(opts, "subscriber")}</table>`,
    text: `${bodyTextLines.join("\n\n")}\n\n${footerText(opts, "subscriber")}`,
  };
}

const DIGEST_SUBJECT = "BCNews - Daily Digest";

/** Lists every item in the order given (callers pass them in `publishedAt` order — no date
 * heading, same as the real legacy sample). */
export function renderDigest(items: RenderItem[], opts: RenderOptions): Rendered {
  const bodyHtml = items.map((item) => itemBlockHtml(item)).join("");
  const bodyText = items.map(itemBlockText).join("\n\n---\n\n");
  return { subject: DIGEST_SUBJECT, html: shellHtml(opts, bodyHtml, "subscriber"), text: shellText(opts, bodyText, "subscriber") };
}

/** Category names/urls for a set of list keys (an item's `listKeys`): names from `lists`,
 * sorted alphabetically case-insensitively; `url` is `lists.topic_url` or null when that's
 * empty. A key with no `lists` row (e.g. an `emergency:*` key nothing has seeded a row for) is
 * simply skipped, never specially excluded — an `emergency:*` key with a real row is included
 * exactly like any other. */
export async function itemCategories(db: DbOrTx, listKeys: string[]): Promise<{ name: string; url: string | null }[]> {
  if (listKeys.length === 0) return [];
  const rows = await db.select({ name: lists.name, topicUrl: lists.topicUrl }).from(lists).where(inArray(lists.listKey, listKeys));
  return rows
    .map((r) => ({ name: r.name, url: r.topicUrl ? r.topicUrl : null }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
