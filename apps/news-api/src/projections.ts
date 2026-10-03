import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { CategoryKind, EventHandler, OrgRecord, ReleaseRecord, SiteContentChanged, TermKind, TermRecord } from "@gcpe/events";
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

export function indexKeysFor(r: Pick<ReleaseRecord, "ministryKeys" | "sectorKeys" | "tagKeys" | "themeKeys">): string[] {
  return [
    ...r.ministryKeys.map((k) => `ministries:${k}`),
    ...r.sectorKeys.map((k) => `sectors:${k}`),
    ...r.tagKeys.map((k) => `tags:${k}`),
    ...r.themeKeys.map((k) => `themes:${k}`),
  ].map((s) => s.toLowerCase());
}

/**
 * `posts.key` is the exact-match conflict target, but there's also a separate unique
 * index on `lower(key)` (Task 3). An incoming key that matches an existing row only by
 * case (e.g. "r1" vs the stored "R1") would hit that lower() index and raise a unique
 * violation instead of upserting. Resolving to the stored casing first — if any — keeps
 * the identity's casing stable across events and makes the insert's own conflict target
 * (`posts.key`, exact) the one that actually fires.
 */
async function resolvePostKey(tx: Tx, key: string): Promise<string> {
  const [existing] = await tx.select({ key: posts.key }).from(posts).where(sql`lower(${posts.key}) = lower(${key})`);
  return existing?.key ?? key;
}

async function resolveCategoryKey(tx: Tx, kind: CategoryKind, key: string): Promise<string> {
  const [existing] = await tx
    .select({ key: categories.key })
    .from(categories)
    .where(and(eq(categories.kind, kind), sql`lower(${categories.key}) = lower(${key})`));
  return existing?.key ?? key;
}

export async function applyRelease(tx: Tx, r: ReleaseRecord): Promise<void> {
  const key = await resolvePostKey(tx, r.key);
  const values = {
    key,
    kind: r.kind,
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
  await tx.insert(posts).values(values).onConflictDoUpdate({ target: posts.key, set: values });
  await notifyUpdate(tx, "PostUpdate", [key]);
}

export async function unpublishRelease(tx: Tx, key: string): Promise<void> {
  const rows = await tx
    .update(posts)
    .set({ isPublished: false })
    .where(sql`lower(${posts.key}) = lower(${key})`)
    .returning({ key: posts.key });
  if (rows.length) await notifyUpdate(tx, "PostUpdate", rows.map((r) => r.key));
}

export async function applyOrg(tx: Tx, org: OrgRecord): Promise<void> {
  const key = await resolveCategoryKey(tx, "ministries", org.key);
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
  await notifyUpdate(tx, "MinistryUpdate", org.parentKey ? [key, org.parentKey] : [key]);
  await notifyUpdate(tx, "MinisterUpdate", [key]);
}

export async function applyTerm(tx: Tx, term: TermRecord): Promise<void> {
  const kind = TERM_TO_CATEGORY[term.kind];
  if (!kind) return;
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
    .returning({ key: categories.key });
  if (rows.length) await notifyUpdate(tx, CATEGORY_TARGET[kind], rows.map((r) => r.key));
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
      await notifyUpdate(tx, CATEGORY_TARGET[c.kind], [c.key]);
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

export function createProjectionHandlers(): Record<string, EventHandler> {
  const termUpserted: EventHandler = (tx, e) => applyTerm(tx, e.data as TermRecord);
  const termDeactivated: EventHandler = async (tx, e) => {
    const d = e.data as { kind: TermKind; key: string };
    const kind = TERM_TO_CATEGORY[d.kind];
    if (kind) await deactivateCategory(tx, kind, d.key);
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
    "release.published": (tx, e) => applyRelease(tx, e.data as ReleaseRecord),
    "release.updated": (tx, e) => applyRelease(tx, e.data as ReleaseRecord),
    "release.unpublished": (tx, e) => unpublishRelease(tx, (e.data as { key: string }).key),
    "site.content.changed": (tx, e) => applySiteContent(tx, e.data as SiteContentChanged),
  };
}
