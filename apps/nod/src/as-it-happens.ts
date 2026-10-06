import { sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import { indexKeysFor, type EventHandler, type ReleaseRecord } from "@gcpe/events";
import { sendJobs } from "./db/schema";

const ENGLISH_LANGUAGE_ID = 4105;

/**
 * Distribution (Task 7) substitutes `{{name}}` placeholders in a single pass over the final
 * html/text, after this module has done its own escaping — so an escaped "{{manageUrl}}"
 * sitting in release text would still read as a live placeholder to Distribution's regex.
 * Breaking up every pair of adjacent braces stops that match, while the one REAL
 * `{{manageUrl}}` — the footer link below — is untouched.
 *
 * P2-R25 item 2: *every* `{` next to another `{` is broken up — not each `{{` match once, which
 * let `{{{manageUrl}}` through as `{ {{manageUrl}}` — so the output never contains `{{` at all,
 * and running it again changes nothing (idempotent). In html, each `{` that follows a `{`
 * becomes the entity `&#123;` (renders identically); in text, each `{` followed by a `{` gets a
 * space after it. Exported for tests.
 */
export const neutralizeHtml = (s: string): string => escapeHtml(s).replace(/(?<=\{)\{/g, "&#123;");
export const neutralizeText = (s: string): string => s.replace(/\{(?=\{)/g, "{ ");

// I4/R2 fix: Distribution rejects (400, terminal) a subject containing CR/LF or longer than
// 998 characters (apps/distribution/src/messages.ts's `z.string().max(998)`, which — like
// every JS/zod string length check — counts UTF-16 *code units*, not Unicode code points) —
// and a raw headline can be either (a release imported with embedded newlines, or simply a
// very long one, including one made of astral-plane characters that are 2 units each). A
// terminal 400 at that layer means nobody gets mailed, so the subject is sanitised here,
// before it ever reaches Distribution.
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
 * the text body does (so a headline that happens to contain `{{manageUrl}}` isn't substituted
 * by Distribution), and truncates to {@link MAX_SUBJECT_UTF16_UNITS}. Falls back to `fallback`
 * (the release key) when the headline is empty or, after trimming, turns out to have been
 * whitespace-only — a subject must never be empty (Distribution's schema requires at least 1
 * character).
 */
function sanitizeSubject(raw: string, fallback: string): string {
  const cleaned = neutralizeText(raw.replace(/\s+/g, " ").trim());
  const base = cleaned.length > 0 ? cleaned : fallback;
  return truncateByUtf16Units(base, MAX_SUBJECT_UTF16_UNITS);
}

export function renderAsItHappens(r: ReleaseRecord, publicSiteUrl: string): { subject: string; html: string; text: string } {
  // Deliberate fallback chain: English document, then whatever document exists, then the
  // release key itself — this subject line must never be empty, even for a release without
  // (yet) an English document.
  const doc = r.documents.find((d) => d.languageId === ENGLISH_LANGUAGE_ID) ?? r.documents[0];
  const headline = doc?.headline || r.key;
  const summary = r.summary ?? "";
  const url = `${publicSiteUrl}/releases/${encodeURIComponent(r.key)}`;

  const subject = sanitizeSubject(headline, r.key);
  const html =
    `<h1>${neutralizeHtml(headline)}</h1>` +
    `<p>${neutralizeHtml(summary)}</p>` +
    `<p><a href="${escapeHtml(url)}">Read the full release</a></p>` +
    `<p><a href="{{manageUrl}}">Manage or unsubscribe</a></p>`;
  const text = `${neutralizeText(headline)}\n\n${neutralizeText(summary)}\n\n${url}\n\nManage or unsubscribe: {{manageUrl}}`;

  return { subject, html, text };
}

export interface AsItHappensOptions {
  publicSiteUrl: string;
  /**
   * Base URL for the manage/unsubscribe page. Not used while rendering (the footer carries the
   * literal `{{manageUrl}}` placeholder; Distribution substitutes it per recipient), but part
   * of this handler's configuration because the per-recipient manage link Task 10 builds from
   * a subscriber's manage_token is relative to it.
   */
  manageUrl: string;
}

/**
 * Turns a `release.published` event into per-subscriber delivery records plus one send job,
 * all inside the receiver's transaction (packages/events/src/receiver.ts).
 */
export function createAsItHappensHandler(opts: AsItHappensOptions): EventHandler {
  return async (tx: Tx, event) => {
    const r = event.data as ReleaseRecord;
    if (!r.publishFlags.toSubscribers) return;

    const keys = indexKeysFor(r);
    // I1 fix: a set-based INSERT...SELECT, entirely server-side — no JS round trip of matched
    // subscriber ids, and so no bind-parameter list to blow Postgres's 65,535-param limit past
    // ~32,767 matched subscribers (2 params/row in the old `.values(matched.map(...))` shape).
    // The list-key match mirrors the old query builder condition: '*' always matches, plus any
    // of this release's own index keys when it has any. `keys` is always small (a handful of
    // ministry/sector/tag/theme keys per release, never subscriber-count-sized), so one bind
    // param per key here is fine — this is not the unbounded list the fix above removes.
    const listKeyMatch = keys.length > 0 ? sql`(sub.list_key = '*' OR sub.list_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}))` : sql`sub.list_key = '*'`;

    const inserted = await tx.execute(sql`
      INSERT INTO deliveries (release_key, subscriber_id)
      SELECT DISTINCT ${r.key}, s.id
        FROM subscribers s
        JOIN subscriptions sub ON sub.subscriber_id = s.id
       WHERE s.status = 'active'
         AND s.as_it_happens = true
         AND ${listKeyMatch}
      ON CONFLICT DO NOTHING
      RETURNING 1
    `);

    // A release matching no active as-it-happens subscriber inserts no delivery rows: skip
    // creating a job entirely (an empty job would send nothing). On a repeat delivery of an
    // already-fully-inserted release (the idempotency case), every row conflicts and this is
    // also 0 — harmless, since the job itself already exists by then (its own insert below is
    // onConflictDoNothing too).
    if (inserted.rows.length === 0) return;

    const { subject, html, text } = renderAsItHappens(r, opts.publicSiteUrl);
    await tx
      .insert(sendJobs)
      .values({ releaseKey: r.key, kind: "as_it_happens", subject, html, text })
      .onConflictDoNothing({ target: [sendJobs.releaseKey, sendJobs.kind] });
  };
}
