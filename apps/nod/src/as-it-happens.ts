import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import { indexKeysFor, type EventHandler, type ReleaseRecord } from "@gcpe/events";
import { deliveries, sendJobs, subscribers, subscriptions } from "./db/schema";

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

export function renderAsItHappens(r: ReleaseRecord, publicSiteUrl: string): { subject: string; html: string; text: string } {
  const doc = r.documents.find((d) => d.languageId === ENGLISH_LANGUAGE_ID) ?? r.documents[0];
  const headline = doc?.headline || r.key;
  const summary = r.summary ?? "";
  const url = `${publicSiteUrl}/releases/${encodeURIComponent(r.key)}`;

  const subject = headline;
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
    const listKeyMatch = keys.length > 0 ? or(eq(subscriptions.listKey, "*"), inArray(subscriptions.listKey, keys)) : eq(subscriptions.listKey, "*");

    const matched = await tx
      .selectDistinct({ id: subscribers.id })
      .from(subscribers)
      .innerJoin(subscriptions, eq(subscriptions.subscriberId, subscribers.id))
      .where(and(isNotNull(subscribers.verifiedAt), eq(subscriptions.asItHappens, true), listKeyMatch));

    // An empty job would send nothing: skip deliveries and the send job entirely.
    if (matched.length === 0) return;

    await tx
      .insert(deliveries)
      .values(matched.map((m) => ({ releaseKey: r.key, subscriberId: m.id })))
      .onConflictDoNothing();

    const { subject, html, text } = renderAsItHappens(r, opts.publicSiteUrl);
    await tx
      .insert(sendJobs)
      .values({ releaseKey: r.key, kind: "as_it_happens", subject, html, text })
      .onConflictDoNothing({ target: [sendJobs.releaseKey, sendJobs.kind] });
  };
}
