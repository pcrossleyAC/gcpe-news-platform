import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx, TestClock } from "@gcpe/db-kit";
import { sqlNow } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { sniff } from "@gcpe/storage";
import { carousels, emergencyPins, websiteSlides } from "../db/schema";
import type { Actor } from "../releases/store";
import { SYSTEM_ACTOR } from "../releases/store";
import { formatBcDateTime } from "../releases/workflow";
import { emitSite, writeSiteLog } from "./events";
import { SiteConflictError, SiteNotFoundError, SiteRuleError } from "./errors";

/**
 * The home-page carousel, its slides and the two emergency pins (plan 3d task 2). See
 * .superpowers/sdd/2026-10-04-phase-3d-website-section/task-2-brief.md for the interfaces and
 * rules this file implements.
 */

export type Justify = "left" | "right";
export type PinSlot = "primary" | "secondary";

export interface SlideView {
  id: string;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: Justify;
  hasImage: boolean;
  imageUrl: string | null;
}

export interface CarouselView {
  id: string;
  state: "live" | "next" | "past";
  goLiveAt: string | null;
  wentLiveAt: string | null;
  version: number;
  slides: SlideView[];
}

export interface PinView {
  slot: PinSlot;
  pinned: boolean;
  version: number;
  slide: SlideView;
}

export interface SlideInput {
  id?: string;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: Justify;
}

export interface PinInput {
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: Justify;
}

const slideImageUrl = (id: string) => `/nrms/api/site/slides/${id}/image`;
const pinImageUrl = (slot: PinSlot) => `/nrms/api/site/pins/${slot}/image`;

type SlideFields = {
  id: string;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: Justify;
  image: Buffer | null;
};

function slideView(s: SlideFields, imageUrl: string): SlideView {
  return {
    id: s.id,
    headline: s.headline,
    summary: s.summary,
    actionUrl: s.actionUrl,
    facebookPostUrl: s.facebookPostUrl,
    justify: s.justify,
    hasImage: s.image !== null,
    imageUrl: s.image !== null ? imageUrl : null,
  };
}

/** No row for this slot yet (pins aren't seeded) — an unpinned, empty slide with no stable id. */
const blankPinSlide = (): SlideView => ({ id: "", headline: "", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null });

function pinView(row: typeof emergencyPins.$inferSelect): PinView {
  return { slot: row.slot, pinned: row.pinned, version: row.version, slide: slideView({ ...row, id: row.slideId }, pinImageUrl(row.slot)) };
}

async function slidesOf(tx: DbOrTx, carouselId: string): Promise<SlideView[]> {
  const rows = await tx.select().from(websiteSlides).where(eq(websiteSlides.carouselId, carouselId)).orderBy(asc(websiteSlides.sortIndex));
  return rows.map((r) => slideView(r, slideImageUrl(r.id)));
}

function carouselView(row: typeof carousels.$inferSelect, slides: SlideView[]): CarouselView {
  return {
    id: row.id,
    state: row.state,
    goLiveAt: row.goLiveAt ? row.goLiveAt.toISOString() : null,
    wentLiveAt: row.wentLiveAt ? row.wentLiveAt.toISOString() : null,
    version: row.version,
    slides,
  };
}

/** Live + next (each with their slides) and the past carousels, newest (most recently retired) first. */
export async function getCarousels(db: DbOrTx): Promise<{ live: CarouselView | null; next: CarouselView | null; past: CarouselView[] }> {
  const rows = await db.select().from(carousels);
  const liveRow = rows.find((r) => r.state === "live") ?? null;
  const nextRow = rows.find((r) => r.state === "next") ?? null;
  const pastRows = rows.filter((r) => r.state === "past").sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const live = liveRow ? carouselView(liveRow, await slidesOf(db, liveRow.id)) : null;
  const next = nextRow ? carouselView(nextRow, await slidesOf(db, nextRow.id)) : null;
  const past = await Promise.all(pastRows.map(async (r) => carouselView(r, await slidesOf(db, r.id))));
  return { live, next, past };
}

/**
 * Starts a new next carousel, copying the live carousel's slides (fresh ids, images copied) or
 * starting empty when there is no live carousel yet. `timeZone` is only used to render the
 * go-live time in the site log line (the brief's shorthand signature omits it, but the log text
 * is specified in BC time).
 */
export async function createNextCarousel(db: Db, input: { goLiveAt: string }, actor: Actor, subs: SubscriberConfig[], timeZone: string): Promise<CarouselView> {
  return db.transaction(async (tx) => {
    const [existingNext] = await tx.select({ id: carousels.id }).from(carousels).where(eq(carousels.state, "next"));
    if (existingNext) throw new SiteConflictError("There is already a next carousel.");

    const goLiveAt = new Date(input.goLiveAt);
    const check = await tx.execute<{ ok: boolean }>(sql`SELECT (${input.goLiveAt}::timestamptz > now()) AS ok`);
    if (!check.rows[0]?.ok) throw new SiteRuleError(["Choose a go-live time in the future."]);

    const [created] = await tx.insert(carousels).values({ state: "next", goLiveAt }).returning();
    const [liveRow] = await tx.select({ id: carousels.id }).from(carousels).where(eq(carousels.state, "live"));
    if (liveRow) {
      const liveSlides = await tx.select().from(websiteSlides).where(eq(websiteSlides.carouselId, liveRow.id)).orderBy(asc(websiteSlides.sortIndex));
      if (liveSlides.length) {
        await tx.insert(websiteSlides).values(
          liveSlides.map((s) => ({
            carouselId: created!.id,
            sortIndex: s.sortIndex,
            headline: s.headline,
            summary: s.summary,
            actionUrl: s.actionUrl,
            facebookPostUrl: s.facebookPostUrl,
            justify: s.justify,
            image: s.image,
            imageType: s.imageType,
          })),
        );
      }
    }
    await writeSiteLog(tx, actor, "carousel", `Created the next carousel for ${formatBcDateTime(goLiveAt, timeZone)}`);
    return carouselView(created!, await slidesOf(tx, created!.id));
  });
}

/**
 * Replaces a carousel's slide list in the given order. Existing ids keep their image; an
 * unknown id is refused. Past carousels are read-only. Saving the live carousel emits a
 * `slides` snapshot; saving the next carousel doesn't (nothing public changed).
 */
export async function saveCarousel(
  db: Db,
  id: string,
  input: { version: number; goLiveAt?: string; slides: SlideInput[] },
  actor: Actor,
  subs: SubscriberConfig[],
): Promise<CarouselView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(carousels).where(eq(carousels.id, id)).for("update");
    if (!row) throw new SiteNotFoundError("carousel not found");
    if (row.state === "past") throw new SiteConflictError("Past carousels can't be changed.");
    if (row.version !== input.version) throw new SiteConflictError();

    const existingSlides = await tx.select().from(websiteSlides).where(eq(websiteSlides.carouselId, id));
    const existingIds = new Set(existingSlides.map((s) => s.id));
    const keepIds = new Set<string>();
    for (const s of input.slides) {
      if (s.id) {
        if (!existingIds.has(s.id)) throw new SiteRuleError([`Unknown slide: ${s.id}`]);
        keepIds.add(s.id);
      }
    }
    const toDelete = existingSlides.filter((s) => !keepIds.has(s.id)).map((s) => s.id);
    if (toDelete.length) await tx.delete(websiteSlides).where(inArray(websiteSlides.id, toDelete));

    for (let i = 0; i < input.slides.length; i++) {
      const s = input.slides[i]!;
      if (s.id) {
        await tx
          .update(websiteSlides)
          .set({ sortIndex: i, headline: s.headline, summary: s.summary, actionUrl: s.actionUrl, facebookPostUrl: s.facebookPostUrl, justify: s.justify, updatedAt: sql`now()` })
          .where(eq(websiteSlides.id, s.id));
      } else {
        await tx.insert(websiteSlides).values({ carouselId: id, sortIndex: i, headline: s.headline, summary: s.summary, actionUrl: s.actionUrl, facebookPostUrl: s.facebookPostUrl, justify: s.justify });
      }
    }

    const [updated] = await tx
      .update(carousels)
      .set({ version: row.version + 1, updatedAt: sql`now()`, ...(input.goLiveAt !== undefined ? { goLiveAt: new Date(input.goLiveAt) } : {}) })
      .where(eq(carousels.id, id))
      .returning();
    await writeSiteLog(tx, actor, "carousel", row.state === "live" ? "Saved the live carousel" : "Saved the next carousel");
    if (row.state === "live") await emitSite(tx, subs, "slides");
    return carouselView(updated!, await slidesOf(tx, id));
  });
}

async function checkImageBytes(bytes: Buffer): Promise<"image/png" | "image/jpeg"> {
  const type = sniff(bytes);
  if (type !== "image/png" && type !== "image/jpeg") throw new SiteRuleError(["Upload a JPEG or PNG image."]);
  return type;
}

/** Sets a carousel slide's image. Emits a `slides` snapshot when the slide belongs to the live carousel. */
export async function setSlideImage(db: Db, slideId: string, bytes: Buffer, actor: Actor, subs: SubscriberConfig[]): Promise<void> {
  const mimeType = await checkImageBytes(bytes);
  await db.transaction(async (tx) => {
    const [slide] = await tx.select({ carouselId: websiteSlides.carouselId }).from(websiteSlides).where(eq(websiteSlides.id, slideId));
    if (!slide) throw new SiteNotFoundError("slide not found");
    await tx.update(websiteSlides).set({ image: bytes, imageType: mimeType, updatedAt: sql`now()` }).where(eq(websiteSlides.id, slideId));
    const [carousel] = await tx.select({ state: carousels.state }).from(carousels).where(eq(carousels.id, slide.carouselId));
    await writeSiteLog(tx, actor, "carousel", "Updated a slide's image");
    if (carousel?.state === "live") await emitSite(tx, subs, "slides");
  });
}

/** Sets an emergency pin's image (the row is created — version 1 — if it doesn't exist yet). Emits when the pin is pinned. */
export async function setPinImage(db: Db, slot: PinSlot, bytes: Buffer, actor: Actor, subs: SubscriberConfig[]): Promise<void> {
  const mimeType = await checkImageBytes(bytes);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(emergencyPins).where(eq(emergencyPins.slot, slot)).for("update");
    const nextVersion = (row?.version ?? 0) + 1;
    await tx
      .insert(emergencyPins)
      .values({ slot, pinned: row?.pinned ?? false, image: bytes, imageType: mimeType, version: nextVersion })
      .onConflictDoUpdate({ target: emergencyPins.slot, set: { image: bytes, imageType: mimeType, version: nextVersion, updatedAt: sql`now()` } });
    await writeSiteLog(tx, actor, "pins", `Updated the ${slot} emergency slide's image`);
    if (row?.pinned) await emitSite(tx, subs, "slides");
  });
}

/** `performSwitch`'s shared mechanics: `nextId` becomes `live`, the old live becomes `past`, past is trimmed to five, logged and emitted. */
async function performSwitch(tx: Tx, nextId: string, subs: SubscriberConfig[], actor: Actor, logText: string, clock?: TestClock): Promise<void> {
  const now = sqlNow(clock);
  const [liveRow] = await tx.select({ id: carousels.id }).from(carousels).where(eq(carousels.state, "live"));
  if (liveRow) await tx.update(carousels).set({ state: "past", updatedAt: now }).where(eq(carousels.id, liveRow.id));
  await tx.update(carousels).set({ state: "live", wentLiveAt: now, updatedAt: now }).where(eq(carousels.id, nextId));

  const pastRows = await tx.select({ id: carousels.id }).from(carousels).where(eq(carousels.state, "past")).orderBy(desc(carousels.updatedAt));
  const toDelete = pastRows.slice(5).map((r) => r.id);
  if (toDelete.length) await tx.delete(carousels).where(inArray(carousels.id, toDelete));

  await writeSiteLog(tx, actor, "carousel", logText);
  await emitSite(tx, subs, "slides");
}

/** The "Make live now" button: promotes the next carousel immediately, ignoring its `go_live_at`. */
export async function makeNextLive(db: Db, actor: Actor, subs: SubscriberConfig[]): Promise<{ switched: boolean }> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`SELECT id FROM ${carousels} WHERE state = 'next' FOR UPDATE SKIP LOCKED`);
    const row = r.rows[0];
    if (!row) throw new SiteNotFoundError("no next carousel");
    await performSwitch(tx, row.id, subs, actor, "Made the next carousel live", undefined);
    return { switched: true };
  });
}

/**
 * The scheduled switch-over worker (`nrms.site` tick step): when a next carousel's
 * `go_live_at <= now()`, promotes it. Claims with `FOR UPDATE SKIP LOCKED` so two concurrent
 * ticks switch once.
 */
export async function switchCarousels(db: Db, subs: SubscriberConfig[], opts: { now?: TestClock } = {}): Promise<{ switched: boolean }> {
  return db.transaction(async (tx) => {
    const now = sqlNow(opts.now);
    const r = await tx.execute<{ id: string }>(sql`SELECT id FROM ${carousels} WHERE state = 'next' AND go_live_at <= ${now} FOR UPDATE SKIP LOCKED`);
    const row = r.rows[0];
    if (!row) return { switched: false };
    await performSwitch(tx, row.id, subs, SYSTEM_ACTOR, "The next carousel went live", opts.now);
    return { switched: true };
  });
}

export async function deleteNextCarousel(db: Db, version: number, actor: Actor): Promise<void> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(carousels).where(eq(carousels.state, "next")).for("update");
    if (!row) throw new SiteNotFoundError("no next carousel");
    if (row.version !== version) throw new SiteConflictError();
    await tx.delete(carousels).where(eq(carousels.id, row.id));
    await writeSiteLog(tx, actor, "carousel", "Deleted the next carousel");
  });
}

/** Both slots, always: an absent row (pins aren't seeded) shows as unpinned, empty, version 0 — the first save must accept version 0. */
export async function getPins(db: DbOrTx): Promise<PinView[]> {
  const rows = await db.select().from(emergencyPins);
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return (["primary", "secondary"] as const).map((slot) => {
    const row = bySlot.get(slot);
    return row ? pinView(row) : { slot, pinned: false, version: 0, slide: blankPinSlide() };
  });
}

/** Saves a pin's content (not its pinned flag — see {@link setPinned}). Upserts by slot since pins aren't seeded. */
export async function savePin(db: Db, slot: PinSlot, input: { version: number } & PinInput, actor: Actor, subs: SubscriberConfig[]): Promise<PinView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(emergencyPins).where(eq(emergencyPins.slot, slot)).for("update");
    const currentVersion = row?.version ?? 0;
    if (currentVersion !== input.version) throw new SiteConflictError();
    const nextVersion = currentVersion + 1;
    const wasPinned = row?.pinned ?? false;
    const [updated] = await tx
      .insert(emergencyPins)
      .values({ slot, pinned: wasPinned, headline: input.headline, summary: input.summary, actionUrl: input.actionUrl, facebookPostUrl: input.facebookPostUrl, justify: input.justify, version: nextVersion })
      .onConflictDoUpdate({
        target: emergencyPins.slot,
        set: { headline: input.headline, summary: input.summary, actionUrl: input.actionUrl, facebookPostUrl: input.facebookPostUrl, justify: input.justify, version: nextVersion, updatedAt: sql`now()` },
      })
      .returning();
    await writeSiteLog(tx, actor, "pins", `Saved the ${slot} emergency slide`);
    if (wasPinned) await emitSite(tx, subs, "slides");
    return pinView(updated!);
  });
}

/** Pins or unpins a slot. Pinning requires a headline. Upserts by slot since pins aren't seeded. */
export async function setPinned(db: Db, slot: PinSlot, input: { version: number; pinned: boolean }, actor: Actor, subs: SubscriberConfig[]): Promise<PinView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(emergencyPins).where(eq(emergencyPins.slot, slot)).for("update");
    const currentVersion = row?.version ?? 0;
    if (currentVersion !== input.version) throw new SiteConflictError();
    if (input.pinned && !row?.headline.trim()) throw new SiteRuleError(["Add a headline before pinning."]);
    const wasPinned = row?.pinned ?? false;
    const nextVersion = currentVersion + 1;
    const [updated] = await tx
      .insert(emergencyPins)
      .values({ slot, pinned: input.pinned, version: nextVersion })
      .onConflictDoUpdate({ target: emergencyPins.slot, set: { pinned: input.pinned, version: nextVersion, updatedAt: sql`now()` } })
      .returning();
    await writeSiteLog(tx, actor, "pins", `${input.pinned ? "Pinned" : "Unpinned"} the ${slot} emergency slide`);
    if (input.pinned || wasPinned) await emitSite(tx, subs, "slides");
    return pinView(updated!);
  });
}

export async function slideImage(db: DbOrTx, id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const [row] = await db.select({ image: websiteSlides.image, imageType: websiteSlides.imageType }).from(websiteSlides).where(eq(websiteSlides.id, id));
  if (!row || !row.image || !row.imageType) return null;
  return { bytes: row.image, mimeType: row.imageType };
}

export async function pinImage(db: DbOrTx, slot: PinSlot): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const [row] = await db.select({ image: emergencyPins.image, imageType: emergencyPins.imageType }).from(emergencyPins).where(eq(emergencyPins.slot, slot));
  if (!row || !row.image || !row.imageType) return null;
  return { bytes: row.image, mimeType: row.imageType };
}
