import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { carousels, publicImportCarousel, publicImportSlides, websiteSlides } from "../db/schema";
import { SYSTEM_ACTOR } from "../releases/store";
import { checkActionLabel, checkImageBytes, performSwitch } from "../website/carousel";
import { emitSite, writeSiteLog } from "../website/events";
import { MAX_SITE_IMAGE_BYTES, publishSlideImage, type SlideImageFiles } from "../website/slide-images";
import { slideInputSchema } from "../website/slide-input";

/**
 * `import:public-slides` (test hosts such as boxs.ca, which never had the legacy SQL import):
 * copies news.gov's CURRENT home-page carousel from the public, read-only legacy News API
 * (`GET /api/Slides`, one request) into NRMS's carousel, and publishes it the way the Hub does.
 *
 * Same rows as the Hub and the SQL importer (import/website.ts): a `carousels` row and its
 * `slides`, images as bytes on the slide (`image`/`image_type`) plus the content-addressed file
 * `slides/<sha256>.<ext>` the Hub's upload writes (website/slide-images.ts). Fields pass the
 * Hub's own save schema (website/slide-input.ts) and images its upload check (PNG/JPEG sniffed
 * from the bytes, at most 2 MiB); here the declared `imageType` must also match the bytes. A
 * slide that fails is refused and reported; the rest are imported.
 *
 * Publishing: the new carousel goes live through the Hub's own switch-over (`performSwitch`,
 * what "Make live now" runs): the old live carousel becomes `past`, one `site_log` line, one
 * `site.content.changed` (`site:slides`) snapshot in the outbox, which the News API projects and
 * the public site rebuilds from. The one difference: past carousels are not trimmed here (the
 * next switch-over trims), so `--remove` can restore the one this replaced. Nothing else is
 * emitted: no release event, nothing for NoD or Distribution, no email.
 *
 * Carousel states are `live` / `next` / `past` (website/carousel.ts) — there is no draft. A
 * staff-scheduled `next` carousel is left alone (and reported): it still goes live at its time.
 *
 * Ownership: `public_import_carousel` (one row) names the carousel this tool made live and the
 * live carousel it replaced; `public_import_slides` maps each imported slide to its news.gov key.
 */

export const DEFAULT_SLIDES_API_BASE = "https://api.news.gov.bc.ca";
export const SLIDES_API_PATH = "/api/Slides?api-version=1.0";
/** The same User-Agent as the News API's `import:public` (apps/news-api/src/import/public-fetch.ts). */
export const PUBLIC_SLIDES_USER_AGENT = "gcpe-boxs-test-import (contact Paul@mtheory.ca)";
export const IMPORT_LOG_TEXT = "Imported news.gov's current carousel (import:public-slides)";

/**
 * The stack's own NRMS subscriber for `site.content.changed` (apps/stack/src/env.ts,
 * INTERNAL_EVENT_ROUTES; pinned by public-slides.test.ts). Only the name and types matter here:
 * an outbox delivery row names its subscriber, and the running stack's dispatcher supplies the
 * URL and signing secret. NRMS sends this event type to no one else.
 */
export const STACK_SITE_SUBSCRIBERS: SubscriberConfig[] = [
  { name: "news-api", url: "http://stack.internal/events", secret: "unused: the running stack signs deliveries", types: ["site.content.changed"] },
];

// --- The source: one request. ---

export interface FetchedSlides {
  url: string;
  status: number;
  body: unknown[];
}

/** One GET of the public Slides list. Anything but a 2xx JSON list is an error (nothing is written). */
export async function fetchPublicSlides(base: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<FetchedSlides> {
  const url = base.replace(/\/+$/, "") + SLIDES_API_PATH;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { "user-agent": PUBLIC_SLIDES_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (res.status === 429) throw new Error(`the public API answered 429 Too Many Requests for ${url}; stopping`);
  if (!res.ok) throw new Error(`the public API answered ${res.status} for ${url}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`the public API's answer for ${url} is not JSON`);
  }
  if (!Array.isArray(body)) throw new Error(`the public API's answer for ${url} is not a list of slides`);
  return { url, status: res.status, body };
}

// --- Mapping and validation (pure). ---

export type ImageType = "image/png" | "image/jpeg";

export interface PublicSlide {
  /** news.gov's slide key (legacy `Slide.Id`), lower case. */
  key: string;
  headline: string;
  summary: string;
  actionUrl: string;
  actionLabel: string;
  facebookPostUrl: string;
  justify: "left" | "right";
  image: Buffer | null;
  imageType: ImageType | null;
}

export interface SlideIssue {
  /** Position in the source list (0-based). */
  index: number;
  key: string | null;
  headline: string | null;
  reasons: string[];
}

export interface MappedSlides {
  /** Importable slides, in the source's (= the carousel's) order. */
  slides: PublicSlide[];
  refused: SlideIssue[];
  /** Imported, with a fallback applied. */
  warnings: SlideIssue[];
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Strict base64 (Node's decoder skips bad characters silently); null when it isn't. */
export function decodeBase64Strict(s: string): Buffer | null {
  const t = s.replace(/\s+/g, "");
  return BASE64.test(t) ? Buffer.from(t, "base64") : null;
}

/** The image as the Hub's upload would take it, or why not. No image at all is allowed (as in the Hub). */
export async function checkPublicSlideImage(image: unknown, imageType: unknown): Promise<{ image: Buffer | null; imageType: ImageType | null } | { reason: string }> {
  if (image === null || image === undefined || image === "") {
    return imageType === null || imageType === undefined || imageType === "" ? { image: null, imageType: null } : { reason: `imageType is ${String(imageType)} but there is no image` };
  }
  if (typeof image !== "string") return { reason: "image is not a base64 string" };
  const bytes = decodeBase64Strict(image);
  if (!bytes || bytes.length === 0) return { reason: "image is not valid base64" };
  if (bytes.length > MAX_SITE_IMAGE_BYTES) return { reason: `image is ${bytes.length} bytes, over the Hub's ${MAX_SITE_IMAGE_BYTES}-byte limit` };
  let sniffed: ImageType;
  try {
    sniffed = await checkImageBytes(bytes);
  } catch {
    return { reason: "image is not a JPEG or PNG (by its bytes)" };
  }
  if (imageType !== sniffed) return { reason: `imageType is ${JSON.stringify(imageType ?? null)} but the bytes are ${sniffed}` };
  return { image: bytes, imageType: sniffed };
}

/** Maps the public API's slide list onto NRMS slides, in order; refuses (and reports) what the Hub wouldn't accept. */
export async function mapPublicSlides(list: unknown[]): Promise<MappedSlides> {
  const out: MappedSlides = { slides: [], refused: [], warnings: [] };
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const raw = list[index];
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const rawKey = strOrNull(o?.key);
    const key = rawKey && z.string().uuid().safeParse(rawKey).success ? rawKey.toLowerCase() : null;
    const headline = strOrNull(o?.headline);
    const reasons: string[] = [];
    const notes: string[] = [];
    if (!o) {
      out.refused.push({ index, key: null, headline: null, reasons: ["not a slide object"] });
      continue;
    }
    if (!key) reasons.push(`key ${JSON.stringify(o.key ?? null)} is not a GUID`);
    else if (seen.has(key)) reasons.push("duplicate key (an earlier slide has it)");

    let justify: "left" | "right" = "left";
    const j = strOrNull(o.justify)?.trim().toLowerCase();
    if (j === "left" || j === "right") justify = j;
    else notes.push(`justify ${JSON.stringify(o.justify ?? null)} is not left/right; using left (the SQL importer's default)`);

    let actionLabel = (strOrNull(o.actionLabel) ?? "").trim();
    try {
      checkActionLabel(actionLabel);
    } catch {
      notes.push(`actionLabel ${JSON.stringify(actionLabel)} breaks the Hub's rule (40 characters, plain text); left empty, so the site shows its default`);
      actionLabel = "";
    }

    const fields = slideInputSchema.safeParse({
      headline: headline ?? "",
      summary: strOrNull(o.summary) ?? "",
      actionUrl: strOrNull(o.actionUri) ?? "",
      actionLabel,
      facebookPostUrl: strOrNull(o.facebookPostUri) ?? "",
      justify,
    });
    if (!fields.success) for (const issue of fields.error.issues) reasons.push(`${issue.path.join(".")}: ${issue.message}`);

    const img = await checkPublicSlideImage(o.image, o.imageType);
    if ("reason" in img) reasons.push(img.reason);
    else if (!img.image) notes.push("no image");

    if (reasons.length > 0 || !fields.success || "reason" in img || !key) {
      out.refused.push({ index, key: key ?? rawKey, headline, reasons });
      continue;
    }
    seen.add(key);
    const f = fields.data;
    out.slides.push({ key, headline: f.headline, summary: f.summary, actionUrl: f.actionUrl, actionLabel: f.actionLabel ?? "", facebookPostUrl: f.facebookPostUrl, justify: f.justify, image: img.image, imageType: img.imageType });
    if (notes.length > 0) out.warnings.push({ index, key, headline, reasons: notes });
  }
  return out;
}

// --- The database side. ---

export interface CarouselSummary {
  carouselId: string;
  state: "live" | "next" | "past";
  slides: { id: string; headline: string; legacyKey: string | null }[];
}

export interface StaffEdit {
  at: string;
  by: string;
  text: string;
}

export type ImportAction = "create" | "update" | "unchanged" | "refused";

export interface ImportDecision {
  action: ImportAction;
  reason?: string;
  /** The live carousel the import replaces (create) or rewrites (update), as it is now. */
  replaces: CarouselSummary | null;
  /** Staff edits that made (or, with --replace, would have made) this a refusal. */
  staffEdits: StaffEdit[];
  /** For an update: what changes, by news.gov key. */
  changes?: { added: string[]; changed: string[]; removed: string[]; reordered: boolean };
  /** A staff-scheduled next carousel, which still goes live at its time. */
  nextCarousel: { carouselId: string; goLiveAt: string | null } | null;
}

type CarouselRow = typeof carousels.$inferSelect;
type SlideRow = typeof websiteSlides.$inferSelect;

async function slidesWithKeys(db: DbOrTx, carouselId: string): Promise<(SlideRow & { legacyKey: string | null })[]> {
  const rows = await db
    .select({ slide: websiteSlides, legacyKey: publicImportSlides.legacyKey })
    .from(websiteSlides)
    .leftJoin(publicImportSlides, eq(publicImportSlides.slideId, websiteSlides.id))
    .where(eq(websiteSlides.carouselId, carouselId))
    .orderBy(asc(websiteSlides.sortIndex));
  return rows.map((r) => ({ ...r.slide, legacyKey: r.legacyKey }));
}

async function summary(db: DbOrTx, row: CarouselRow): Promise<CarouselSummary> {
  const slides = await slidesWithKeys(db, row.id);
  return { carouselId: row.id, state: row.state, slides: slides.map((s) => ({ id: s.id, headline: s.headline, legacyKey: s.legacyKey })) };
}

/**
 * Carousel edits by anyone but the system (every Hub carousel action writes a `carousel`
 * site_log line: create/save/image/make-live/delete), at or after the given carousel's creation
 * or strictly after the import. Compared in SQL, at the database's own (microsecond) precision.
 */
async function staffCarouselEdits(db: DbOrTx, since: { carouselCreated: string } | "import"): Promise<StaffEdit[]> {
  const bound =
    since === "import"
      ? sql`at > (SELECT imported_at FROM public_import_carousel WHERE id = 1)`
      : sql`at >= (SELECT created_at FROM carousels WHERE id = ${since.carouselCreated})`;
  const { rows } = await db.execute<{ at: string | Date; actor_name: string; text: string }>(sql`
    SELECT at, actor_name, text FROM site_log
     WHERE area = 'carousel' AND actor_id <> ${SYSTEM_ACTOR.id} AND ${bound}
     ORDER BY at DESC LIMIT 5`);
  return rows.map((r) => ({ at: new Date(r.at).toISOString(), by: r.actor_name, text: r.text }));
}

const sameBytes = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

function slideChanged(row: SlideRow, s: PublicSlide): boolean {
  return (
    row.headline !== s.headline ||
    row.summary !== s.summary ||
    row.actionUrl !== s.actionUrl ||
    row.actionLabel !== s.actionLabel ||
    row.facebookPostUrl !== s.facebookPostUrl ||
    row.justify !== s.justify ||
    row.imageType !== s.imageType ||
    !sameBytes(row.image, s.image)
  );
}

function diff(current: (SlideRow & { legacyKey: string | null })[], wanted: PublicSlide[]): NonNullable<ImportDecision["changes"]> {
  const byKey = new Map(current.filter((c) => c.legacyKey).map((c) => [c.legacyKey!, c]));
  const wantedKeys = new Set(wanted.map((s) => s.key));
  const added = wanted.filter((s) => !byKey.has(s.key)).map((s) => s.key);
  const changed = wanted.filter((s) => byKey.has(s.key) && slideChanged(byKey.get(s.key)!, s)).map((s) => s.key);
  const removed = current.filter((c) => !c.legacyKey || !wantedKeys.has(c.legacyKey)).map((c) => c.legacyKey ?? `(slide ${c.id}, not imported)`);
  const reordered = current.map((c) => c.legacyKey ?? "").join(",") !== wanted.map((s) => s.key).join(",");
  return { added, changed, removed, reordered };
}

/** False before migration 0020 (a dry run against a database the new stack hasn't started on yet). */
async function hasTrackingTable(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ t: string | null }>(sql`SELECT to_regclass('public.public_import_carousel')::text AS t`);
  return rows[0]?.t != null;
}

/** What an import of `slides` would do now, read-only. */
export async function decideImport(db: DbOrTx, slides: PublicSlide[], opts: { replace: boolean }): Promise<ImportDecision> {
  const rows = await db.select().from(carousels);
  const live = rows.find((r) => r.state === "live") ?? null;
  const next = rows.find((r) => r.state === "next") ?? null;
  const [tracked] = (await hasTrackingTable(db)) ? await db.select().from(publicImportCarousel) : [];
  const base = { nextCarousel: next ? { carouselId: next.id, goLiveAt: next.goLiveAt ? next.goLiveAt.toISOString() : null } : null, staffEdits: [] as StaffEdit[] };

  if (slides.length === 0) {
    return { ...base, action: "refused", reason: "the source has no importable slides; refusing to empty the carousel", replaces: live ? await summary(db, live) : null };
  }

  if (tracked) {
    if (!live || live.id !== tracked.carouselId) {
      return {
        ...base,
        action: "refused",
        reason: `the carousel this tool imported on ${tracked.importedAt.toISOString()} is no longer live (staff have published another since); run --remove first (it leaves the live carousel alone), then import again (with --replace to replace that one)`,
        replaces: live ? await summary(db, live) : null,
      };
    }
    const current = await slidesWithKeys(db, live.id);
    const changes = diff(current, slides);
    const replaces = await summary(db, live);
    if (!changes.added.length && !changes.changed.length && !changes.removed.length && !changes.reordered) return { ...base, action: "unchanged", replaces };
    const staffEdits = await staffCarouselEdits(db, "import");
    if (staffEdits.length > 0 && !opts.replace) {
      return { ...base, action: "refused", reason: "staff have edited the imported carousel since it was imported; pass --replace to overwrite their edits", replaces, staffEdits, changes };
    }
    return { ...base, action: "update", replaces, staffEdits, changes };
  }

  if (!live) return { ...base, action: "create", replaces: null };
  const replaces = await summary(db, live);
  const staffEdits = await staffCarouselEdits(db, { carouselCreated: live.id });
  if (staffEdits.length > 0 && !opts.replace) {
    return { ...base, action: "refused", reason: "staff have edited the live carousel; pass --replace to replace it (--remove puts it back)", replaces, staffEdits };
  }
  return { ...base, action: "create", replaces, staffEdits };
}

/** Takes the carousel table for the rest of the transaction: the Hub's carousel writes (which lock rows) wait, reads don't. */
async function lockCarousels(tx: Tx): Promise<void> {
  await tx.execute(sql`LOCK TABLE carousels IN EXCLUSIVE MODE`);
}

async function publishImages(files: SlideImageFiles, slides: PublicSlide[]): Promise<void> {
  for (const s of slides) if (s.image && s.imageType) await publishSlideImage(files, s.image, s.imageType);
}

const slideValues = (s: PublicSlide, sortIndex: number) => ({
  sortIndex,
  headline: s.headline,
  summary: s.summary,
  actionUrl: s.actionUrl,
  actionLabel: s.actionLabel,
  facebookPostUrl: s.facebookPostUrl,
  justify: s.justify,
  image: s.image,
  imageType: s.imageType,
});

export interface ImportResult extends ImportDecision {
  /** The imported carousel (live), when there is one. */
  carouselId?: string;
}

/**
 * Imports `slides` as the live carousel, in one transaction (decided again under the lock, so a
 * concurrent Hub edit can't slip between the check and the write). Image files are written
 * before the event that names them can commit, as the Hub's upload does.
 */
export async function importPublicSlides(db: Db, slides: PublicSlide[], deps: { subscribers: SubscriberConfig[]; files: SlideImageFiles; replace: boolean }): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    await lockCarousels(tx);
    const decision = await decideImport(tx, slides, { replace: deps.replace });
    if (decision.action === "refused") return decision;
    const [tracked] = await tx.select().from(publicImportCarousel);
    if (decision.action === "unchanged") return { ...decision, carouselId: tracked!.carouselId };

    await publishImages(deps.files, slides);

    if (decision.action === "create") {
      // Inserted as `past` (invisible, no go-live time needed, and not the one `next` slot a
      // staff schedule may hold); performSwitch then makes it live exactly as "Make live now" does.
      const [created] = await tx.insert(carousels).values({ state: "past" }).returning();
      const inserted = await tx
        .insert(websiteSlides)
        .values(slides.map((s, i) => ({ carouselId: created!.id, ...slideValues(s, i) })))
        .returning({ id: websiteSlides.id, sortIndex: websiteSlides.sortIndex });
      await tx.insert(publicImportSlides).values(inserted.map((r) => ({ slideId: r.id, legacyKey: slides[r.sortIndex]!.key })));
      // The replaced carousel's id and updated_at, copied in SQL (full precision) before the switch moves it.
      await tx.execute(sql`
        INSERT INTO public_import_carousel (id, carousel_id, previous_live_id, previous_live_updated_at)
        SELECT 1, ${created!.id}::uuid, l.id, l.updated_at
          FROM (SELECT 1) AS one LEFT JOIN carousels l ON l.state = 'live'`);
      await performSwitch(tx, created!.id, deps.subscribers, SYSTEM_ACTOR, IMPORT_LOG_TEXT, deps.files, undefined, { trimPast: false });
      return { ...decision, carouselId: created!.id };
    }

    // update: the imported carousel is live; rewrite its slides in place, matched by news.gov key
    // (ids, and so the public site's slide ids, stay stable), as one Hub save would.
    const carouselId = tracked!.carouselId;
    const current = await slidesWithKeys(tx, carouselId);
    const byKey = new Map(current.filter((c) => c.legacyKey).map((c) => [c.legacyKey!, c]));
    const wanted = new Set(slides.map((s) => s.key));
    for (const c of current) if (!c.legacyKey || !wanted.has(c.legacyKey)) await tx.delete(websiteSlides).where(eq(websiteSlides.id, c.id));
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i]!;
      const row = byKey.get(s.key);
      if (row) {
        const changed = slideChanged(row, s);
        if (changed || row.sortIndex !== i) {
          await tx
            .update(websiteSlides)
            .set({ ...slideValues(s, i), ...(changed ? { updatedAt: sql`now()` } : {}) })
            .where(eq(websiteSlides.id, row.id));
        }
      } else {
        const [ins] = await tx.insert(websiteSlides).values({ carouselId, ...slideValues(s, i) }).returning({ id: websiteSlides.id });
        await tx.insert(publicImportSlides).values({ slideId: ins!.id, legacyKey: s.key });
      }
    }
    await tx.update(carousels).set({ version: sql`${carousels.version} + 1`, updatedAt: sql`now()` }).where(eq(carousels.id, carouselId));
    await tx.update(publicImportCarousel).set({ importedAt: sql`now()` }).where(eq(publicImportCarousel.id, 1));
    await writeSiteLog(tx, SYSTEM_ACTOR, "carousel", "Updated the imported news.gov carousel (import:public-slides)");
    await emitSite(tx, deps.subscribers, "slides", deps.files);
    return { ...decision, carouselId };
  });
}

// --- --remove ---

export type RemoveAction = "restore" | "drop-past" | "nothing" | "refused";

export interface RemoveDecision {
  action: RemoveAction;
  reason?: string;
  /** The imported carousel. */
  imported: CarouselSummary | null;
  /** The carousel `restore` makes live again; null when there was none before the import. */
  restores: CarouselSummary | null;
  staffEdits: StaffEdit[];
  warnings: string[];
}

export async function decideRemove(db: DbOrTx, opts: { replace: boolean }): Promise<RemoveDecision> {
  const [tracked] = (await hasTrackingTable(db)) ? await db.select().from(publicImportCarousel) : [];
  const none: RemoveDecision = { action: "nothing", imported: null, restores: null, staffEdits: [], warnings: [] };
  if (!tracked) return { ...none, reason: "this tool has not imported a carousel here (or it was removed)" };
  const [imported] = await db.select().from(carousels).where(eq(carousels.id, tracked.carouselId));
  const importedSummary = await summary(db, imported!);
  if (imported!.state !== "live") {
    return { ...none, action: "drop-past", imported: importedSummary, reason: "the imported carousel is no longer live: it is deleted, and the live carousel is left alone" };
  }
  const warnings: string[] = [];
  let restores: CarouselSummary | null = null;
  if (tracked.previousLiveId) {
    const [prev] = await db.select().from(carousels).where(eq(carousels.id, tracked.previousLiveId));
    if (prev) restores = await summary(db, prev);
    else warnings.push(`the carousel the import replaced (${tracked.previousLiveId}) no longer exists (a later switch-over trimmed it); the site will have no carousel`);
  }
  const staffEdits = await staffCarouselEdits(db, "import");
  if (staffEdits.length > 0 && !opts.replace) {
    return { action: "refused", reason: "staff have edited the carousel since the import; pass --replace to remove it anyway (their edits to it go too)", imported: importedSummary, restores, staffEdits, warnings };
  }
  return { action: "restore", imported: importedSummary, restores, staffEdits, warnings };
}

/**
 * Undoes the import: deletes the imported carousel (its slides and tracking rows cascade) and,
 * when it is still live, makes the carousel it replaced live again with that carousel's own
 * `updated_at` back (its slides, version and went-live time were never touched), then emits the
 * same `slides` snapshot the Hub would — the site shows exactly what it showed before. Image
 * files stay (content-addressed and shared, as the Hub leaves them).
 */
export async function removePublicSlides(db: Db, deps: { subscribers: SubscriberConfig[]; files: SlideImageFiles; replace: boolean }): Promise<RemoveDecision> {
  return db.transaction(async (tx) => {
    await lockCarousels(tx);
    const decision = await decideRemove(tx, { replace: deps.replace });
    if (decision.action === "nothing" || decision.action === "refused") return decision;
    const [tracked] = await tx.select().from(publicImportCarousel);
    // Read as text, at full (microsecond) precision, before the delete below cascades the row away.
    const { rows } = await tx.execute<{ t: string | null }>(sql`SELECT previous_live_updated_at::text AS t FROM public_import_carousel WHERE id = 1`);
    const previousUpdatedAt = rows[0]?.t ?? null;
    await tx.delete(carousels).where(eq(carousels.id, tracked!.carouselId));
    if (decision.action === "drop-past") {
      await writeSiteLog(tx, SYSTEM_ACTOR, "carousel", "Deleted the imported news.gov carousel, no longer live (import:public-slides --remove)");
      return decision;
    }
    if (decision.restores) {
      await tx.execute(sql`
        UPDATE carousels SET state = 'live', updated_at = ${previousUpdatedAt ? sql`${previousUpdatedAt}::timestamptz` : sql`now()`}
         WHERE id = ${decision.restores.carouselId} AND state = 'past'`);
    }
    await writeSiteLog(
      tx,
      SYSTEM_ACTOR,
      "carousel",
      decision.restores ? "Removed the imported news.gov carousel and made the previous carousel live again (import:public-slides --remove)" : "Removed the imported news.gov carousel; there was no carousel before it (import:public-slides --remove)",
    );
    await emitSite(tx, deps.subscribers, "slides", deps.files);
    return decision;
  });
}

// --- The whole command (for public-slides-cli.ts and its tests). ---

export interface PublicSlidesOptions {
  from: string;
  dryRun: boolean;
  remove: boolean;
  replace: boolean;
}

export interface PublicSlidesReport {
  mode: "import" | "dry-run" | "remove" | "remove-dry-run";
  source?: {
    url: string;
    requests: number;
    listed: number;
    slides: { position: number; key: string; headline: string; justify: string; actionLabel: string; actionUrl: string; facebookPostUrl: string; image: { type: string; bytes: number; sha256: string } | null }[];
    refused: SlideIssue[];
    warnings: SlideIssue[];
  };
  /** The import's outcome, or (dry run with a database) what it would be. */
  write?: ImportResult;
  remove?: RemoveDecision;
  /** True when the command did not do (or, dry run, would not do) its job: the CLI exits 1. */
  failed: boolean;
}

export async function runPublicSlides(
  deps: { db: Db | null; fetchSlides: () => Promise<FetchedSlides>; subscribers: SubscriberConfig[]; files: SlideImageFiles | null },
  o: PublicSlidesOptions,
): Promise<PublicSlidesReport> {
  if (o.remove) {
    if (!deps.db) throw new Error("--remove needs the database, even with --dry-run");
    if (o.dryRun) {
      const remove = await decideRemove(deps.db, { replace: o.replace });
      return { mode: "remove-dry-run", remove, failed: remove.action === "refused" };
    }
    if (!deps.files) throw new Error("--remove needs the slide image settings (STORAGE_DIR, PUBLIC_FILES_BASE)");
    const remove = await removePublicSlides(deps.db, { subscribers: deps.subscribers, files: deps.files, replace: o.replace });
    return { mode: "remove", remove, failed: remove.action === "refused" };
  }
  if (!deps.db && !o.dryRun) throw new Error("a database is required unless --dry-run");
  const fetched = await deps.fetchSlides();
  const mapped = await mapPublicSlides(fetched.body);
  const report: PublicSlidesReport = {
    mode: o.dryRun ? "dry-run" : "import",
    source: {
      url: fetched.url,
      requests: 1,
      listed: fetched.body.length,
      slides: mapped.slides.map((s, position) => ({
        position,
        key: s.key,
        headline: s.headline,
        justify: s.justify,
        actionLabel: s.actionLabel,
        actionUrl: s.actionUrl,
        facebookPostUrl: s.facebookPostUrl,
        image: s.image && s.imageType ? { type: s.imageType, bytes: s.image.length, sha256: createHash("sha256").update(s.image).digest("hex") } : null,
      })),
      refused: mapped.refused,
      warnings: mapped.warnings,
    },
    failed: mapped.slides.length === 0,
  };
  if (!deps.db) return report;
  if (o.dryRun) report.write = await decideImport(deps.db, mapped.slides, { replace: o.replace });
  else {
    if (!deps.files) throw new Error("an import needs the slide image settings (STORAGE_DIR, PUBLIC_FILES_BASE)");
    report.write = await importPublicSlides(deps.db, mapped.slides, { subscribers: deps.subscribers, files: deps.files, replace: o.replace });
  }
  // `failed` last, after the outcome it summarises.
  const { failed: _unset, ...rest } = report;
  return { ...rest, failed: report.write.action === "refused" };
}
