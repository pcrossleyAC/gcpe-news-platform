import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SiteContentChanged, type SlideRecord, type SubscriberConfig } from "@gcpe/events";
import { carousels, categoryFeatures, emergencyPins, newsReleases, siteLog, siteSettings, type SiteLogArea, websiteResourceLinks, websiteSlides } from "../db/schema";
import type { Actor } from "../releases/store";

/** Mirrors releases/store.ts's `writeLog`: actor, area and a length-capped line. */
export async function writeSiteLog(tx: DbOrTx, actor: Actor, area: SiteLogArea, text: string): Promise<void> {
  await tx.insert(siteLog).values({ actorId: actor.id, actorName: actor.name, area, text: text.slice(0, 500) });
}

async function releaseKeyOf(tx: DbOrTx, releaseId: string | null): Promise<string | null> {
  if (!releaseId) return null;
  const [row] = await tx.select({ key: newsReleases.key }).from(newsReleases).where(eq(newsReleases.id, releaseId));
  return row?.key ?? null;
}

export type FeatureKind = "ministries" | "sectors" | "themes";

/** The home page's Top/Feature slots, live-feed URLs and Blue Bridge `granville` text. */
export async function homeSnapshot(tx: DbOrTx): Promise<SiteContentChanged & { entity: "home" }> {
  const [settings] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1));
  if (!settings) throw new Error("site_settings has no row — the website migration should have inserted id=1");
  const [feature] = await tx.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, "home"), eq(categoryFeatures.key, "default")));
  const [topPostKey, featurePostKey] = await Promise.all([
    releaseKeyOf(tx, feature?.topReleaseId ?? null),
    releaseKeyOf(tx, feature?.featureReleaseId ?? null),
  ]);
  return {
    entity: "home",
    topPostKey,
    featurePostKey,
    liveWebcastFlashMediaManifestUrl: settings.liveFeedEnabled ? settings.liveManifestUrl || null : null,
    liveWebcastM3uPlaylist: settings.liveFeedEnabled ? settings.liveM3uUrl || null : null,
    granville: settings.granville ?? null,
    timestamp: settings.updatedAt.toISOString(),
  };
}

function toSlideRecord(s: {
  id: string;
  sortIndex: number;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: "left" | "right";
  image: Buffer | null;
  imageType: string | null;
  updatedAt: Date;
}): SlideRecord {
  return {
    id: s.id,
    sortIndex: s.sortIndex,
    headline: s.headline,
    summary: s.summary,
    actionLabel: null,
    actionUri: s.actionUrl || null,
    imageBase64: s.image ? s.image.toString("base64") : null,
    imageType: s.imageType,
    facebookPostUri: s.facebookPostUrl || null,
    justify: s.justify === "right" ? "Right" : "Left",
    timestamp: s.updatedAt.toISOString(),
  };
}

/**
 * Pinned emergency slides first (`primary` → sortIndex -2, `secondary` → -1, only when
 * `pinned`), then the live carousel's slides renumbered 0..n-1 in their stored order. No
 * live carousel → only the pins (possibly none).
 */
export async function slidesSnapshot(tx: DbOrTx): Promise<SiteContentChanged & { entity: "slides" }> {
  const pins = await tx.select().from(emergencyPins).where(eq(emergencyPins.pinned, true));
  const bySlot = new Map(pins.map((p) => [p.slot, p]));
  const pinSlides: SlideRecord[] = [];
  const primary = bySlot.get("primary");
  if (primary) pinSlides.push(toSlideRecord({ ...primary, id: primary.slideId, sortIndex: -2 }));
  const secondary = bySlot.get("secondary");
  if (secondary) pinSlides.push(toSlideRecord({ ...secondary, id: secondary.slideId, sortIndex: -1 }));

  const [live] = await tx.select().from(carousels).where(eq(carousels.state, "live"));
  let liveSlides: SlideRecord[] = [];
  if (live) {
    const rows = await tx.select().from(websiteSlides).where(eq(websiteSlides.carouselId, live.id)).orderBy(asc(websiteSlides.sortIndex));
    liveSlides = rows.map((s, i) => toSlideRecord({ ...s, sortIndex: i }));
  }
  return { entity: "slides", slides: [...pinSlides, ...liveSlides] };
}

/** The resource links list (Task 3), ordered by `sort_index`. */
export async function linksSnapshot(tx: DbOrTx): Promise<SiteContentChanged & { entity: "resourceLinks" }> {
  const rows = await tx.select().from(websiteResourceLinks).orderBy(asc(websiteResourceLinks.sortIndex));
  const [settings] = await tx.select({ updatedAt: siteSettings.updatedAt }).from(siteSettings).where(eq(siteSettings.id, 1));
  return {
    entity: "resourceLinks",
    links: rows.map((r) => ({ sortIndex: r.sortIndex, text: r.text, uri: r.url })),
    timestamp: (settings?.updatedAt ?? new Date()).toISOString(),
  };
}

/** A category's Top/Feature slot (Task 5). */
export async function featureSnapshot(tx: DbOrTx, kind: FeatureKind, key: string): Promise<SiteContentChanged & { entity: "categoryFeatures" }> {
  const [row] = await tx.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key)));
  const [topPostKey, featurePostKey] = await Promise.all([
    releaseKeyOf(tx, row?.topReleaseId ?? null),
    releaseKeyOf(tx, row?.featureReleaseId ?? null),
  ]);
  return { entity: "categoryFeatures", kind, key, topPostKey, featurePostKey };
}

/**
 * Builds the right full snapshot and enqueues it as `site.content.changed`, in the caller's
 * transaction — so the event only exists if the write that triggered it also committed.
 */
export async function emitSite(
  tx: Tx,
  subscribers: SubscriberConfig[],
  which: "home" | "slides" | "links" | { kind: FeatureKind; key: string },
): Promise<void> {
  let data: SiteContentChanged;
  let aggregateId: string;
  if (which === "home") {
    data = await homeSnapshot(tx);
    aggregateId = "site:home";
  } else if (which === "slides") {
    data = await slidesSnapshot(tx);
    aggregateId = "site:slides";
  } else if (which === "links") {
    data = await linksSnapshot(tx);
    aggregateId = "site:resourceLinks";
  } else {
    data = await featureSnapshot(tx, which.kind, which.key);
    aggregateId = `site:feature:${which.kind}:${which.key}`;
  }
  await enqueueEvent(tx, { type: "site.content.changed", source: "nrms", aggregateId, data }, subscribers);
}
