import { and, eq, isNull, or, sql } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type DbOrTx, type TestClock } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { emergencyItemKey, type ItemSending } from "../as-it-happens";
import { items, nodSettings } from "../db/schema";
import { FeedFormatError, normalizeLinkIdentity, parseEmergencyFeed, type FeedAlert } from "./feed";

export const EMERGENCY_FEED_INTERVAL_MS = 5 * 60_000;
export const FEED_TIMEOUT_MS = 15_000;
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

/** What one check did, kept on nod_settings for Operations. `error` is a label, never a body. */
export interface EmergencyFeedResult {
  at: string;
  ok: boolean;
  /** This check was a first read of the URL: alerts were recorded, nothing was sent. */
  seeded: boolean;
  inFeed: number;
  created: number;
  updated: number;
  skipped: number;
  /** Alerts whose own create/update failed -- logged by label only, never stopping the rest. */
  failed: number;
  error: string | null;
}

export interface EmergencyFeedStatus {
  url: string | null;
  checkedAt: string | null;
  result: EmergencyFeedResult | null;
}

export class FeedFetchError extends Error {
  constructor(public readonly kind: string) {
    super(`emergency feed fetch failed: ${kind}`);
    this.name = "FeedFetchError";
  }
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
/** `fetch`'s own redirect:"error" rejection -- a `TypeError` whose `cause` names the redirect
 * (undici: "unexpected redirect"). The operator must configure the feed's real, final URL;
 * silently following a redirect would let whoever controls the redirect's target choose what
 * the ingester reads instead. */
const isRedirect = (e: unknown) => e instanceof Error && e.cause instanceof Error && /redirect/i.test(e.cause.message);

/** GETs the feed with a time limit (covering the body too), a size cap, and no redirects. */
export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      redirect: "error",
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1" },
    });
  } catch (e) {
    throw new FeedFetchError(isTimeout(e) ? "timeout" : isRedirect(e) ? "redirect" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FeedFetchError(`http-${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FeedFetchError("too-large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof FeedFetchError) throw e;
    throw new FeedFetchError(isTimeout(e) ? "timeout" : "network");
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One atomic UPDATE claims the 5-minute gate, by the database clock: two concurrent callers
 * resolve to one claim (the second re-evaluates its WHERE against the committed row). */
async function claimFeedGate(db: Db, now?: TestClock): Promise<{ seededUrl: string | null; checkedAt: Date } | null> {
  const n = sqlNow(now);
  const [row] = await db
    .update(nodSettings)
    .set({ emergencyFeedCheckedAt: n })
    .where(
      and(
        eq(nodSettings.id, 1),
        or(isNull(nodSettings.emergencyFeedCheckedAt), sql`${nodSettings.emergencyFeedCheckedAt} <= ${n} - ${sqlInterval(EMERGENCY_FEED_INTERVAL_MS)}`),
      ),
    )
    .returning({ seededUrl: nodSettings.emergencyFeedSeededUrl, checkedAt: nodSettings.emergencyFeedCheckedAt });
  return row ? { seededUrl: row.seededUrl, checkedAt: row.checkedAt! } : null;
}

interface KnownEmergencyRow {
  key: string;
  title: string;
  summary: string;
  url: string;
}

/** Every emergency item NoD already has, oldest first -- loaded once per check (not once per
 * alert): cheap given how few emergency alerts there ever are, and it lets a later alert in the
 * same feed see one an earlier alert in the *same* run just created. */
async function loadKnownEmergencyItems(db: DbOrTx): Promise<KnownEmergencyRow[]> {
  return db
    .select({ key: items.key, title: items.title, summary: items.summary, url: items.url })
    .from(items)
    .where(eq(items.kind, "emergency"))
    .orderBy(items.publishedAt);
}

/** An alert is known by its key or by its link, so a guid change alone never re-sends it --
 * matched by {@link normalizeLinkIdentity} on both sides, so a link that only changed case,
 * scheme or a trailing slash still matches. */
function findKnownEmergencyItem(known: KnownEmergencyRow[], alert: FeedAlert): KnownEmergencyRow | undefined {
  const wantKey = emergencyItemKey(alert.identity);
  const wantLink = normalizeLinkIdentity(alert.link);
  return known.find((row) => row.key === wantKey || normalizeLinkIdentity(row.url) === wantLink);
}

export interface EmergencyFeedDeps {
  db: Db;
  /** EMERGENCY_FEED_URL; null = no feed, nothing is read. */
  url: string | null;
  items: Pick<ItemSending, "recordEmergencyItem">;
  fetch?: typeof fetch;
  now?: TestClock;
}

/**
 * The 5-minute emergency feed check. A new alert becomes an emergency item and is sent to
 * everyone on emergency:alerts. A known one (same key or same link) whose title or text
 * changed is updated in place and never re-sent, as legacy did. The first successful read of a
 * URL records everything without sending. Any failure records its label; alerts recorded
 * before it stay, and the next check carries on from there.
 */
export async function runEmergencyFeedIfDue(deps: EmergencyFeedDeps): Promise<{ ran: boolean; result?: EmergencyFeedResult }> {
  if (!deps.url) return { ran: false };
  const gate = await claimFeedGate(deps.db, deps.now);
  if (!gate) return { ran: false };

  const seeding = gate.seededUrl !== deps.url;
  const result: EmergencyFeedResult = { at: gate.checkedAt.toISOString(), ok: false, seeded: seeding, inFeed: 0, created: 0, updated: 0, skipped: 0, failed: 0, error: null };
  try {
    const parsed = parseEmergencyFeed(await fetchFeed(deps.url, deps.fetch));
    result.inFeed = parsed.alerts.length;
    result.skipped = parsed.skipped;
    const known = await loadKnownEmergencyItems(deps.db);
    for (const alert of parsed.alerts) {
      try {
        const row = findKnownEmergencyItem(known, alert);
        if (row) {
          if (row.title === alert.title && row.summary === alert.text) continue;
          await deps.db.update(items).set({ title: alert.title, summary: alert.text, updatedAt: sql`now()` }).where(eq(items.key, row.key));
          row.title = alert.title;
          row.summary = alert.text;
          result.updated += 1;
          continue;
        }
        const { key, created } = await deps.items.recordEmergencyItem(
          deps.db,
          { guid: alert.identity, title: alert.title, summary: alert.text, url: alert.link, publishedAt: alert.publishedAt?.toISOString() },
          { send: !seeding },
        );
        if (created) {
          result.created += 1;
          known.push({ key, title: alert.title, summary: alert.text, url: alert.link });
        }
      } catch (e) {
        // One alert's own failure (e.g. a value the database itself rejects) never stops the
        // rest of the feed -- logged by label only, counted, never the alert's own content.
        result.failed += 1;
        console.error(`[nod] emergency feed item failed: ${safeErrorLabel(e)}`);
      }
    }
    // Any per-item failure leaves the whole check not-ok -- while seeding, that also means
    // nodSettings.emergencyFeedSeededUrl below is left unset, so the next check seeds again
    // instead of treating the alert that failed as newly arrived (and sending it) once it
    // eventually succeeds.
    result.ok = result.failed === 0;
  } catch (e) {
    result.error = e instanceof FeedFetchError ? e.kind : e instanceof FeedFormatError ? "not-a-feed" : safeErrorLabel(e);
    console.error(`[nod] emergency feed check failed: ${result.error}`);
  }

  await deps.db
    .update(nodSettings)
    .set({ emergencyFeedResult: result, ...(result.ok && seeding ? { emergencyFeedSeededUrl: deps.url } : {}), updatedAt: sql`now()` })
    .where(eq(nodSettings.id, 1));
  return { ran: true, result };
}

/** The feed URL as Operations may show it: any user name and password written into it removed. */
function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return "";
  }
}

export async function getEmergencyFeedStatus(db: DbOrTx, url: string | null): Promise<EmergencyFeedStatus> {
  const [row] = await db
    .select({ checkedAt: nodSettings.emergencyFeedCheckedAt, result: nodSettings.emergencyFeedResult })
    .from(nodSettings)
    .where(eq(nodSettings.id, 1));
  return { url: url === null ? null : withoutCredentials(url), checkedAt: row?.checkedAt ? row.checkedAt.toISOString() : null, result: (row?.result as EmergencyFeedResult | null) ?? null };
}
