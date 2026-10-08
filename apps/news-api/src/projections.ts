import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import {
  enqueueEvent,
  indexKeysFor,
  type CategoryKind,
  type EventEnvelope,
  type EventHandler,
  type OrgRecord,
  type ReleaseRecord,
  type SiteContentChanged,
  type SubscriberConfig,
  type TermKind,
  type TermRecord,
} from "@gcpe/events";
import { categories, categoryFeatures, home, posts, resourceLinks, slides } from "./db/schema";
import { parseOffsetDateTime } from "./time";
import { notifyUpdate, type UpdateTarget } from "./updates/notify";

export const TERM_TO_CATEGORY: Record<TermKind, CategoryKind | null> = { sector: "sectors", theme: "themes", tag: "tags", service: null };

const CATEGORY_TARGET: Record<CategoryKind, UpdateTarget> = {
  ministries: "MinistryUpdate",
  sectors: "SectorUpdate",
  themes: "ThemeUpdate",
  tags: "TagUpdate",
};

export { indexKeysFor };

/**
 * Serialises writers of one case-insensitive identity for the rest of the transaction.
 * findExistingPost/resolveCategoryKey are plain reads: two concurrent first writes of the
 * same key in different casings ("CASE-1" vs "case-1") would both see no row, both insert
 * with their own casing, and the loser would raise 23505 on the lower(key) unique index —
 * the exact-key ON CONFLICT target can't absorb it. Taking this lock BEFORE the read means
 * the second writer waits for the first to commit, and its read (a fresh read-committed
 * snapshot) then sees and adopts the stored casing.
 */
async function lockIdentity(tx: Tx, scope: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope} || ':' || lower(${key})))`);
}

/**
 * `posts.key` is the exact-match conflict target, but there's also a separate unique
 * index on `lower(key)` (Task 3). An incoming key that matches an existing row only by
 * case (e.g. "r1" vs the stored "R1") would hit that lower() index and raise a unique
 * violation instead of upserting. Resolving to the stored casing first — if any — keeps
 * the identity's casing stable across events and makes the insert's own conflict target
 * (`posts.key`, exact) the one that actually fires. Also returns the row's current
 * `origin`, so `applyRelease` can decide (ruling P1-R21) whether a legacy write is even
 * allowed to proceed.
 */
async function findExistingPost(tx: Tx, key: string): Promise<{ key: string; origin: "legacy" | "event" } | undefined> {
  const [existing] = await tx
    .select({ key: posts.key, origin: posts.origin })
    .from(posts)
    .where(sql`lower(${posts.key}) = lower(${key})`);
  return existing;
}

async function resolveCategoryKey(tx: Tx, kind: CategoryKind, key: string): Promise<string> {
  const [existing] = await tx
    .select({ key: categories.key })
    .from(categories)
    .where(and(eq(categories.kind, kind), sql`lower(${categories.key}) = lower(${key})`));
  return existing?.key ?? key;
}

export interface ApplyOptions {
  /**
   * false suppresses the PostUpdate NOTIFY. Only the bulk legacy import uses this: one
   * SignalR broadcast per release (~100k) to every webapp client is the wrong behaviour.
   */
  notify?: boolean;
  /**
   * Which pipeline is writing: 'legacy' (the importer) or 'event' (an NRMS
   * release.published/release.updated event). Default 'event'.
   *
   * origin: "legacy" is not just a label — it's also a guard (ruling P1-R21/P1-R22). If the
   * stored row already has origin "event" (NRMS has published or updated this key, even one
   * the legacy importer originally created), a "legacy" write is refused entirely: no upsert,
   * no notification, nothing changes. applyRelease returns `{ skippedEventOwned: true }`
   * instead. Without this, the importer's full periodic reimport would otherwise revert the
   * row's origin back to "legacy" and silently overwrite NRMS's current content with
   * legacy's now-stale copy on its very next run.
   *
   * This is enforced atomically in SQL (`onConflictDoUpdate`'s `setWhere`, ruling P1-R22), not
   * by reading the row first and deciding in application code — a read-then-write check would
   * race against a concurrent NRMS event that commits in between, overwriting it anyway while
   * still reporting success. An "event" write always proceeds unconditionally and always
   * wins — NRMS is authoritative for any key once it has published to it.
   */
  origin?: "legacy" | "event";
}

export async function applyRelease(tx: Tx, r: ReleaseRecord, opts: ApplyOptions = {}): Promise<{ skippedEventOwned: boolean }> {
  const origin = opts.origin ?? "event";
  // A plain read, used only to resolve the existing row's stored key casing (see
  // findExistingPost) and as a cheap, OPTIONAL early-exit for the common case where the skip
  // is already obviously correct. It is never what correctness rests on: between this read
  // and the write below, a concurrent NRMS event can still commit — see the setWhere guard.
  await lockIdentity(tx, "posts", r.key);
  const existing = await findExistingPost(tx, r.key);
  if (origin === "legacy" && existing?.origin === "event") {
    return { skippedEventOwned: true };
  }
  const key = existing?.key ?? r.key;
  const values = {
    key,
    kind: r.kind,
    origin,
    reference: r.reference,
    atomId: r.atomId,
    publishDate: parseOffsetDateTime(r.publishDate),
    leadMinistryKey: r.leadMinistryKey,
    summary: r.summary,
    socialMediaSummary: r.socialMediaSummary,
    socialMediaHeadline: r.socialMediaHeadline,
    keywords: r.keywords,
    location: r.location,
    hasMediaAssets: r.hasMediaAssets,
    hasTranslations: r.hasTranslations,
    isNewsOnDemand: r.isNewsOnDemand,
    assetUrl: r.assetUrl,
    redirectUri: r.redirectUri,
    documents: r.documents,
    ministryKeys: r.ministryKeys,
    sectorKeys: r.sectorKeys,
    tagKeys: r.tagKeys,
    themeKeys: r.themeKeys,
    indexKeys: indexKeysFor(r),
    assets: r.assets,
    translations: r.translations,
    isPublished: true,
    timestamp: parseOffsetDateTime(r.timestamp),
  };
  if (origin === "legacy") {
    // Ruling P1-R22: the actual guard. If a concurrent transaction applying an NRMS event for
    // this same key commits between our read above and this statement, this upsert's row
    // lock blocks until that commit, then Postgres re-evaluates setWhere against the
    // now-committed row — origin = 'event' — and skips the UPDATE instead of applying `set`.
    // RETURNING then yields zero rows, which is what skippedEventOwned is actually derived
    // from (never from the pre-check above). A fresh insert (no conflicting row at all) is
    // unaffected by setWhere and always proceeds.
    const written = await tx
      .insert(posts)
      .values(values)
      .onConflictDoUpdate({ target: posts.key, set: values, setWhere: sql`${posts.origin} <> 'event'` })
      .returning({ key: posts.key });
    if (written.length === 0) return { skippedEventOwned: true };
  } else {
    await tx.insert(posts).values(values).onConflictDoUpdate({ target: posts.key, set: values });
  }
  if (opts.notify !== false) await notifyUpdate(tx, "PostUpdate", [key]);
  return { skippedEventOwned: false };
}

export async function unpublishRelease(tx: Tx, key: string): Promise<void> {
  const rows = await tx
    .update(posts)
    .set({ isPublished: false })
    .where(sql`lower(${posts.key}) = lower(${key})`)
    .returning({ key: posts.key });
  if (rows.length) await notifyUpdate(tx, "PostUpdate", rows.map((r) => r.key));
}

/** `[key, ...parents]` with each parent resolved to its stored casing, deduplicated case-insensitively. */
async function withStoredParentKeys(tx: Tx, key: string, parents: (string | null)[]): Promise<string[]> {
  const keys = [key];
  for (const parent of parents) {
    if (!parent) continue;
    const stored = await resolveCategoryKey(tx, "ministries", parent);
    if (!keys.some((k) => k.toLowerCase() === stored.toLowerCase())) keys.push(stored);
  }
  return keys;
}

export async function applyOrg(tx: Tx, org: OrgRecord): Promise<void> {
  await lockIdentity(tx, "categories:ministries", org.key);
  const key = await resolveCategoryKey(tx, "ministries", org.key);
  const [previous] = await tx
    .select({ ministry: categories.ministry })
    .from(categories)
    .where(and(eq(categories.kind, "ministries"), eq(categories.key, key)));
  const values = {
    kind: "ministries" as const,
    key,
    name: org.displayName,
    sortOrder: org.sortOrder,
    isActive: org.isActive,
    social: org.social,
    ministry: {
      parentKey: org.parentKey,
      url: org.url,
      displayAdditionalName: org.displayAdditionalName,
      minister: org.minister,
      contact: org.contact,
      secondContact: org.secondContact,
      weekendContactNumber: org.weekendContactNumber,
      topicLinks: org.topicLinks,
      serviceLinks: org.serviceLinks,
    },
    timestamp: parseOffsetDateTime(org.updatedAt),
  };
  await tx.insert(categories).values(values).onConflictDoUpdate({ target: [categories.kind, categories.key], set: values });
  // A parent's childMinistryKey is derived from its children, so both the new parent and —
  // if the child moved — the previous one render differently now (final review M6).
  const parents = [org.parentKey, previous?.ministry?.parentKey ?? null];
  await notifyUpdate(tx, "MinistryUpdate", await withStoredParentKeys(tx, key, parents));
  await notifyUpdate(tx, "MinisterUpdate", [key]);
}

export async function applyTerm(tx: Tx, term: TermRecord): Promise<void> {
  const kind = TERM_TO_CATEGORY[term.kind];
  if (!kind) return;
  await lockIdentity(tx, `categories:${kind}`, term.key);
  const key = await resolveCategoryKey(tx, kind, term.key);
  const values = {
    kind,
    key,
    name: term.displayName,
    sortOrder: term.sortOrder,
    isActive: term.isActive,
    social: term.social,
    ministry: null,
    timestamp: parseOffsetDateTime(term.updatedAt),
  };
  await tx.insert(categories).values(values).onConflictDoUpdate({ target: [categories.kind, categories.key], set: values });
  await notifyUpdate(tx, CATEGORY_TARGET[kind], [key]);
}

export async function deactivateCategory(tx: Tx, kind: CategoryKind, key: string): Promise<void> {
  const rows = await tx
    .update(categories)
    .set({ isActive: false })
    .where(and(eq(categories.kind, kind), sql`lower(${categories.key}) = lower(${key})`, eq(categories.isActive, true)))
    .returning({ key: categories.key, ministry: categories.ministry });
  if (!rows.length) return;
  const keys = rows.map((r) => r.key);
  if (kind === "ministries") {
    // Deactivating a child can change its parent's childMinistryKey (only active children
    // count), so the parent is notified too (final review M6).
    for (const r of rows) {
      for (const k of await withStoredParentKeys(tx, r.key, [r.ministry?.parentKey ?? null])) {
        if (!keys.some((existing) => existing.toLowerCase() === k.toLowerCase())) keys.push(k);
      }
    }
  }
  await notifyUpdate(tx, CATEGORY_TARGET[kind], keys);
}

export async function applySiteContent(tx: Tx, c: SiteContentChanged): Promise<void> {
  switch (c.entity) {
    case "home": {
      const values = {
        key: "default",
        topPostKey: c.topPostKey,
        featurePostKey: c.featurePostKey,
        liveWebcastFlashMediaManifestUrl: c.liveWebcastFlashMediaManifestUrl,
        liveWebcastM3uPlaylist: c.liveWebcastM3uPlaylist,
        granville: c.granville,
        timestamp: parseOffsetDateTime(c.timestamp),
      };
      await tx.insert(home).values(values).onConflictDoUpdate({ target: home.key, set: values });
      await notifyUpdate(tx, "HomeUpdate", ["default"]);
      return;
    }
    case "categoryFeatures": {
      const values = { kind: c.kind, key: c.key.toLowerCase(), topPostKey: c.topPostKey, featurePostKey: c.featurePostKey };
      await tx.insert(categoryFeatures).values(values).onConflictDoUpdate({ target: [categoryFeatures.kind, categoryFeatures.key], set: values });
      // Notify with the category's stored casing (as every other category notification does),
      // falling back to the event's key when the category doesn't exist (yet).
      await notifyUpdate(tx, CATEGORY_TARGET[c.kind], [await resolveCategoryKey(tx, c.kind, c.key)]);
      return;
    }
    case "slides": {
      await tx.delete(slides);
      if (c.slides.length) {
        await tx.insert(slides).values(
          c.slides.map((s) => ({
            id: s.id,
            sortIndex: s.sortIndex,
            headline: s.headline,
            summary: s.summary,
            actionLabel: s.actionLabel,
            actionUri: s.actionUri,
            image: s.imageBase64 === null ? null : Buffer.from(s.imageBase64, "base64"),
            imageType: s.imageType,
            facebookPostUri: s.facebookPostUri,
            justify: s.justify,
            timestamp: parseOffsetDateTime(s.timestamp),
          })),
        );
      }
      await notifyUpdate(
        tx,
        "SlideUpdate",
        c.slides.map((s) => s.id),
      );
      return;
    }
    case "resourceLinks": {
      await tx.delete(resourceLinks);
      const ts = parseOffsetDateTime(c.timestamp);
      if (c.links.length) await tx.insert(resourceLinks).values(c.links.map((l) => ({ ...l, timestamp: ts })));
      await notifyUpdate(tx, "ResourceLinkUpdate", []);
      return;
    }
  }
}

export interface ProjectionOptions {
  subscribers?: SubscriberConfig[];
}

/**
 * Enqueues `site.rebuild_requested` for the post identified by `key`, in the same
 * transaction as the projection write that triggered it (so the outbox row only exists if
 * the projection write committed too).
 *
 * `aggregateId` is per post (`post:<lowercased key>`), not a single shared `site` aggregate:
 * the receiver drops events whose sequence is lower than the last applied for that
 * aggregate. With one shared aggregate, a retried rebuild for post A delivered after a
 * newer one for post B would be dropped as stale, and A's page would never be rebuilt. Per
 * post, a newer rebuild of the same post correctly supersedes an older one.
 */
async function requestRebuild(tx: Tx, key: string, correlationId: string, subscribers: SubscriberConfig[]): Promise<void> {
  await enqueueEvent(
    tx,
    { type: "site.rebuild_requested", source: "news-api", aggregateId: `post:${key.toLowerCase()}`, data: { pages: ["home", `post:${key}`] }, correlationId },
    subscribers,
  );
}

/**
 * Enqueues `site.rebuild_requested` for just the home page, in the same transaction as the
 * `site.content.changed` write that triggered it. One fixed aggregate (`site:home-page`,
 * distinct from NRMS's own `site:home` snapshot aggregate) is fine here — unlike
 * {@link requestRebuild}, every home-page content change competes for the same page, so
 * sequence-based staleness dropping the odd retried rebuild in favour of a newer one is the
 * correct behaviour, not a bug.
 */
async function requestHomeRebuild(tx: Tx, correlationId: string, subscribers: SubscriberConfig[]): Promise<void> {
  await enqueueEvent(
    tx,
    { type: "site.rebuild_requested", source: "news-api", aggregateId: "site:home-page", data: { pages: ["home"] }, correlationId },
    subscribers,
  );
}

export function createProjectionHandlers(opts: ProjectionOptions = {}): Record<string, EventHandler> {
  const subscribers = opts.subscribers ?? [];
  const termUpserted: EventHandler = (tx, e) => applyTerm(tx, e.data as TermRecord);
  const termDeactivated: EventHandler = async (tx, e) => {
    const d = e.data as { kind: TermKind; key: string };
    const kind = TERM_TO_CATEGORY[d.kind];
    if (kind) await deactivateCategory(tx, kind, d.key);
  };
  const releaseApplied: EventHandler = async (tx, e) => {
    const r = e.data as ReleaseRecord;
    await applyRelease(tx, r);
    await requestRebuild(tx, r.key, e.correlationId, subscribers);
  };
  return {
    "org.upserted": (tx, e) => applyOrg(tx, e.data as OrgRecord),
    "org.deactivated": (tx, e) => deactivateCategory(tx, "ministries", (e.data as { key: string }).key),
    "sector.upserted": termUpserted,
    "theme.upserted": termUpserted,
    "tag.upserted": termUpserted,
    "sector.deactivated": termDeactivated,
    "theme.deactivated": termDeactivated,
    "tag.deactivated": termDeactivated,
    "release.published": releaseApplied,
    "release.updated": releaseApplied,
    "release.unpublished": async (tx, e) => {
      const { key } = e.data as { key: string };
      await unpublishRelease(tx, key);
      await requestRebuild(tx, key, e.correlationId, subscribers);
    },
    "site.content.changed": async (tx, e) => {
      const c = e.data as SiteContentChanged;
      await applySiteContent(tx, c);
      if (c.entity === "home") await requestHomeRebuild(tx, e.correlationId, subscribers);
    },
  };
}

/**
 * Which source may drive which event types (final review M1). Core owns reference data;
 * NRMS owns releases and site content; news-api owns site.rebuild_requested (it emits it; the News API itself has no handler for it, so a received one is "ignored"); distribution owns
 * delivery.bounced the same way (Phase 4e: emitted to NoD, not the News API — News API never
 * receives one, but still must own it so the catalogue-coverage test below has exactly one
 * owner for every type). A signed event of the wrong family from a source —
 * e.g. an nrms-signed `org.deactivated` — is recorded as "ignored" rather than applied, so
 * one source's credentials can't rewrite the other's data.
 */
export const SOURCE_EVENT_TYPES: Record<string, (type: string) => boolean> = {
  core: (type) => /^(org|sector|theme|tag|service|user)\./.test(type),
  nrms: (type) => type.startsWith("release.") || type === "site.content.changed" || type.startsWith("media_list."),
  "news-api": (type) => type === "site.rebuild_requested",
  distribution: (type) => type.startsWith("delivery."),
};

/** The receiver's handler lookup: `createProjectionHandlers()`, restricted by event.source. */
export function createSourceRestrictedHandlers(opts: ProjectionOptions = {}): (event: EventEnvelope) => EventHandler | undefined {
  const handlers = createProjectionHandlers(opts);
  return (event) => {
    const allowed = Object.hasOwn(SOURCE_EVENT_TYPES, event.source) ? SOURCE_EVENT_TYPES[event.source] : undefined;
    if (!allowed?.(event.type) || !Object.hasOwn(handlers, event.type)) return undefined;
    return handlers[event.type];
  };
}
