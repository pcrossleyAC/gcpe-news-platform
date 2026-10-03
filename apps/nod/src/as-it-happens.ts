import { sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import { indexKeysFor, type EventHandler, type ReleaseRecord } from "@gcpe/events";
import { sendJobs } from "./db/schema";

const ENGLISH_LANGUAGE_ID = 4105;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Distribution (Task 7) substitutes `{{name}}` placeholders in a single pass over the final
 * html/text, after this module has done its own escaping — so an escaped "{{manageUrl}}"
 * sitting in release text would still read as a live placeholder to Distribution's regex.
 * Breaking the brace pair (one half becomes an HTML entity in html, or gets a space in text)
 * stops that match, while the one REAL `{{manageUrl}}` — the footer link below — is untouched.
 */
const neutralizeHtml = (s: string): string => escapeHtml(s).replace(/\{\{/g, "{&#123;");
const neutralizeText = (s: string): string => s.replace(/\{\{/g, "{ {");

// I4 fix: Distribution rejects (400, terminal) a subject containing CR/LF or longer than 998
// characters (apps/distribution/src/messages.ts's messageRequestSchema) — and a raw headline
// can be either (a release imported with embedded newlines, or simply a very long one). A
// terminal 400 at that layer means nobody gets mailed, so the subject is sanitised here,
// before it ever reaches Distribution.
const MAX_SUBJECT_CODE_POINTS = 998;

/**
 * Collapses all whitespace (including \r\n\t, which would otherwise smuggle extra header
 * lines into the SMTP Subject header) to single spaces, trims, neutralises `{{` the same way
 * the text body does (so a headline that happens to contain `{{manageUrl}}` isn't substituted
 * by Distribution), and truncates to {@link MAX_SUBJECT_CODE_POINTS} Unicode code points —
 * counting code points rather than UTF-16 units so a truncation point can't land mid
 * surrogate-pair. The last character becomes "…" when truncation actually happens.
 */
function sanitizeSubject(raw: string): string {
  const cleaned = neutralizeText(raw.replace(/\s+/g, " ").trim());
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= MAX_SUBJECT_CODE_POINTS) return cleaned;
  return codePoints.slice(0, MAX_SUBJECT_CODE_POINTS - 1).join("") + "…";
}

export function renderAsItHappens(r: ReleaseRecord, publicSiteUrl: string): { subject: string; html: string; text: string } {
  // Deliberate fallback chain: English document, then whatever document exists, then the
  // release key itself — this subject line must never be empty, even for a release without
  // (yet) an English document.
  const doc = r.documents.find((d) => d.languageId === ENGLISH_LANGUAGE_ID) ?? r.documents[0];
  const headline = doc?.headline || r.key;
  const summary = r.summary ?? "";
  const url = `${publicSiteUrl}/releases/${encodeURIComponent(r.key)}`;

  const subject = sanitizeSubject(headline);
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
       WHERE s.verified_at IS NOT NULL
         AND sub.as_it_happens = true
         AND ${listKeyMatch}
      ON CONFLICT DO NOTHING
      RETURNING 1
    `);

    // A release matching no verified as-it-happens subscriber inserts no delivery rows: skip
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
