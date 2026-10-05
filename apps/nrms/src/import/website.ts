/**
 * Phase 3e (NRMS legacy importer, spec §8, task 4): carousels and their slides, the two
 * emergency pins, the Live Feed on/off flag, Project Blue Bridge's `granville` text and the
 * resource links — the "website" half of the legacy site (everything in migration 0012's
 * tables). See .superpowers/sdd/2026-10-04-phase-3e-nrms-importer/task-4-brief.md.
 *
 * Carousels, their slides and the resource links have no legacy-id column of their own (see
 * codemap.md §3), so a re-run replaces all three wholesale, in this function's own transaction,
 * rather than diffing row by row. `site_settings` (Live Feed + `granville`) and the two seeded
 * `emergency_pins` rows DO have a stable identity (a singleton row, and the fixed slots
 * `primary`/`secondary`), so those are compared against their current content and only written
 * (and versioned) when something actually changed — keeping an unchanged re-run from endlessly
 * bumping `site_settings.version` or an emergency pin's own `version`.
 *
 * No events: this importer never calls `emitSite`/`enqueueEvent` (the News API's own importer
 * already carries this content to the public site from its own copy of the legacy data).
 */
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { imageTypeFromBytes, isGranvilleOn, justifyFromLegacy, normalizeGranville, type LegacySource } from "@gcpe/legacy-import";
import { carousels, emergencyPins, siteSettings, siteLog, websiteResourceLinks, websiteSlides } from "../db/schema";
import { SYSTEM_ACTOR } from "../releases/store";
import { Q_APP_SETTINGS, Q_CAROUSELS, Q_CAROUSEL_SLIDES, Q_RESOURCE_LINKS } from "./queries";
import type { ImportReport } from "./report";

// --- Raw legacy row shapes (see queries.ts for the exact SQL). ---
interface RawAppSettingRow extends Record<string, unknown> {
  SettingName: string;
  SettingValue: string;
}
interface RawCarouselRow extends Record<string, unknown> {
  Id: string;
  PublishDateTime: Date | null;
  Timestamp: Date;
}
interface RawCarouselSlideRow extends Record<string, unknown> {
  CarouselId: string;
  SlideId: string;
  SortIndex: number;
  Headline: string | null;
  Summary: string | null;
  ActionUrl: string | null;
  Image: Buffer | null;
  FacebookPostUrl: string | null;
  Justify: number | null;
  Timestamp: Date;
}
interface RawResourceLinkRow extends Record<string, unknown> {
  SortIndex: number;
  LinkText: string | null;
  LinkUrl: string | null;
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row).toLowerCase();
    out.set(key, [...(out.get(key) ?? []), row]);
  }
  return out;
}

function bufEq(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

interface SlideFields {
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: "left" | "right";
  image: Buffer | null;
  imageType: string | null;
}

function slideFields(row: RawCarouselSlideRow): SlideFields {
  const image = row.Image ?? null;
  return {
    headline: row.Headline ?? "",
    summary: row.Summary ?? "",
    actionUrl: row.ActionUrl ?? "",
    facebookPostUrl: row.FacebookPostUrl ?? "",
    justify: justifyFromLegacy(row.Justify) ?? "left",
    image,
    imageType: imageTypeFromBytes(image),
  };
}

// --- Carousel state assignment (task-4 brief): newest PublishDateTime <= now → live; the
// earliest PublishDateTime > now → next (further future ones skipped); the five newest
// remaining past ones → past; older past ones skipped; a null PublishDateTime can't be placed
// on this timeline at all, so it's skipped too. ---
interface CarouselPlan {
  live: RawCarouselRow | null;
  next: RawCarouselRow | null;
  past: RawCarouselRow[];
  skipped: { row: RawCarouselRow; reason: string }[];
}

function planCarousels(rows: RawCarouselRow[], now: Date): CarouselPlan {
  const withDate = rows.filter((r) => r.PublishDateTime !== null);
  const skipped: { row: RawCarouselRow; reason: string }[] = rows
    .filter((r) => r.PublishDateTime === null)
    .map((row) => ({ row, reason: "no publish date" }));

  const nowMs = now.getTime();
  const pastOrLive = withDate
    .filter((r) => r.PublishDateTime!.getTime() <= nowMs)
    .sort((a, b) => b.PublishDateTime!.getTime() - a.PublishDateTime!.getTime());
  const future = withDate
    .filter((r) => r.PublishDateTime!.getTime() > nowMs)
    .sort((a, b) => a.PublishDateTime!.getTime() - b.PublishDateTime!.getTime());

  const live = pastOrLive[0] ?? null;
  const pastCandidates = pastOrLive.slice(1);
  const past = pastCandidates.slice(0, 5);
  for (const row of pastCandidates.slice(5)) skipped.push({ row, reason: "more than five past carousels" });

  const next = future[0] ?? null;
  for (const row of future.slice(1)) skipped.push({ row, reason: "more than one upcoming carousel" });

  return { live, next, past, skipped };
}

async function importCarousels(tx: Tx, carouselRows: RawCarouselRow[], slideRows: RawCarouselSlideRow[], now: Date, report: ImportReport): Promise<void> {
  for (const _row of carouselRows) report.count("carousels", "legacy");
  const plan = planCarousels(carouselRows, now);

  const selected: { row: RawCarouselRow; state: "live" | "next" | "past" }[] = [
    ...(plan.live ? [{ row: plan.live, state: "live" as const }] : []),
    ...(plan.next ? [{ row: plan.next, state: "next" as const }] : []),
    ...plan.past.map((row) => ({ row, state: "past" as const })),
  ];
  const selectedIds = new Set(selected.map((s) => s.row.Id.toLowerCase()));
  const skipReasonById = new Map(plan.skipped.map(({ row, reason }) => [row.Id.toLowerCase(), reason]));

  for (const _s of selected) report.count("carousels", "imported");
  for (const { row, reason } of plan.skipped) report.skip("carousels", row.Id.toLowerCase(), reason);

  const slidesByCarousel = groupBy(slideRows, (r) => r.CarouselId);

  // Wholesale replace: carousels have no legacy-id column to diff against, so every successful
  // run deletes and reinserts (cascading to `slides`) rather than trying to match old rows.
  await tx.delete(carousels);

  for (const { row, state } of selected) {
    const [created] = await tx
      .insert(carousels)
      .values({
        state,
        goLiveAt: state === "next" ? row.PublishDateTime : null,
        wentLiveAt: state === "next" ? null : row.PublishDateTime,
      })
      .returning({ id: carousels.id });

    const legacySlides = [...(slidesByCarousel.get(row.Id.toLowerCase()) ?? [])].sort((a, b) => a.SortIndex - b.SortIndex);
    const values: (typeof websiteSlides.$inferInsert)[] = [];
    let sortIndex = 0;
    for (const s of legacySlides) {
      report.count("slides", "legacy");
      if (s.SortIndex < 0) {
        report.skip("slides", `${row.Id.toLowerCase()}:${s.SlideId.toLowerCase()}`, "pinned slide (SortIndex < 0), not a carousel slide");
        continue;
      }
      values.push({ carouselId: created!.id, sortIndex: sortIndex++, ...slideFields(s) });
      report.count("slides", "imported");
    }
    if (values.length) await tx.insert(websiteSlides).values(values);
  }

  for (const row of carouselRows) {
    if (selectedIds.has(row.Id.toLowerCase())) continue;
    const reason = skipReasonById.get(row.Id.toLowerCase());
    if (!reason) continue;
    for (const s of slidesByCarousel.get(row.Id.toLowerCase()) ?? []) {
      report.count("slides", "legacy");
      report.skip("slides", `${row.Id.toLowerCase()}:${s.SlideId.toLowerCase()}`, `carousel skipped: ${reason}`);
    }
  }
}

async function importResourceLinks(tx: Tx, rows: RawResourceLinkRow[], report: ImportReport): Promise<void> {
  await tx.delete(websiteResourceLinks);
  const sorted = [...rows].sort((a, b) => a.SortIndex - b.SortIndex);
  if (sorted.length) {
    await tx.insert(websiteResourceLinks).values(sorted.map((r) => ({ sortIndex: r.SortIndex, text: r.LinkText ?? "", url: r.LinkUrl ?? "" })));
  }
  for (const _row of rows) {
    report.count("resource_links", "legacy");
    report.count("resource_links", "imported");
  }
}

// --- Emergency pins (task-4 brief): legacy's exact ApplicationSetting keys, from
// Hub.Legacy.Website/News/EmergencySlideManagement.aspx.cs:16-21/45-50 — a pinned slide is a
// CarouselSlide row with SortIndex < 0 inside the carousel named by PinnedCarouselId /
// SecondaryCarouselId. ---
const PIN_SETTINGS = {
  primary: { isPinned: "IsPinnedSlide", slideId: "PinnedSlideId", carouselId: "PinnedCarouselId" },
  secondary: { isPinned: "IsPinnedSecondarySlide", slideId: "SecondarySlideId", carouselId: "SecondaryCarouselId" },
} as const;

async function importPins(tx: Tx, settings: Map<string, string>, slideRows: RawCarouselSlideRow[], now: Date, report: ImportReport): Promise<void> {
  const bySlideCarousel = new Map(slideRows.map((r) => [`${r.CarouselId.toLowerCase()}\u0000${r.SlideId.toLowerCase()}`, r]));

  for (const slot of ["primary", "secondary"] as const) {
    const names = PIN_SETTINGS[slot];
    const flagged = isGranvilleOn(settings.get(names.isPinned));
    const slideIdRaw = settings.get(names.slideId);
    const carouselIdRaw = settings.get(names.carouselId);

    let match: RawCarouselSlideRow | undefined;
    if (flagged && slideIdRaw && carouselIdRaw) {
      match = bySlideCarousel.get(`${carouselIdRaw.toLowerCase()}\u0000${slideIdRaw.toLowerCase()}`);
    }
    if (flagged && !match) {
      report.warn(slideIdRaw ?? slot, `pin:${slot}`, ["pinned slide setting points at an unknown carousel/slide — left unpinned"]);
    }

    const [current] = await tx.select().from(emergencyPins).where(eq(emergencyPins.slot, slot)).for("update");
    if (!current) throw new Error(`emergency_pins has no seeded row for slot ${slot} — migration 0012 should have seeded both slots`);

    const pinned = flagged && Boolean(match);
    const desired: SlideFields & { pinned: boolean } = match
      ? { pinned, ...slideFields(match) }
      : { pinned, headline: current.headline, summary: current.summary, actionUrl: current.actionUrl, facebookPostUrl: current.facebookPostUrl, justify: current.justify, image: current.image, imageType: current.imageType };

    const changed =
      current.pinned !== desired.pinned ||
      current.headline !== desired.headline ||
      current.summary !== desired.summary ||
      current.actionUrl !== desired.actionUrl ||
      current.facebookPostUrl !== desired.facebookPostUrl ||
      current.justify !== desired.justify ||
      current.imageType !== desired.imageType ||
      !bufEq(current.image, desired.image);

    if (changed) {
      await tx.update(emergencyPins).set({ ...desired, version: current.version + 1, updatedAt: now }).where(eq(emergencyPins.slot, slot));
    }
  }
}

/**
 * Re-run rule (controller ruling): skip the whole website import when `site_settings` was
 * edited since the last import — either its own `version` has moved past what was recorded as
 * `website_imported_version`, or `site_log` has a non-system entry after `website_imported_at`
 * (a carousel/pin/resource-link edit, which doesn't touch `site_settings.version` itself but
 * always writes a log line — see website/events.ts's `writeSiteLog`, called by every save*
 * function in website/carousel.ts and website/settings.ts).
 */
async function websiteEditedSinceImport(tx: Tx, settingsRow: typeof siteSettings.$inferSelect): Promise<string | null> {
  const REASON = "website edited in NRMS since the last import";
  if (settingsRow.websiteImportedVersion != null && settingsRow.websiteImportedVersion !== settingsRow.version) {
    return REASON;
  }
  if (settingsRow.websiteImportedAt) {
    const [row] = await tx
      .select({ id: siteLog.id })
      .from(siteLog)
      .where(and(gt(siteLog.at, settingsRow.websiteImportedAt), ne(siteLog.actorId, SYSTEM_ACTOR.id)))
      .limit(1);
    if (row) return REASON;
  }
  return null;
}

export interface ImportWebsiteResult {
  skipped: boolean;
  reason?: string;
}

export async function importWebsite(db: Db, source: LegacySource, report: ImportReport, opts: { force: boolean }): Promise<ImportWebsiteResult> {
  return db.transaction(async (tx) => {
    const [settingsRow] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for("update");
    if (!settingsRow) throw new Error("site_settings has no row — the website migration should have inserted id=1");

    if (!opts.force) {
      const reason = await websiteEditedSinceImport(tx, settingsRow);
      if (reason) return { skipped: true, reason };
    }

    // Constraints: "now" for live/next/past decisions is the DB clock, not Date.now() (same
    // idiom as releases/workflow.ts's dbClock — the driver can hand this back as a string).
    const nowResult = await tx.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
    const now = new Date(nowResult.rows[0]!.now);

    const appSettingRows = await source.query<RawAppSettingRow>(Q_APP_SETTINGS);
    const carouselRows = await source.query<RawCarouselRow>(Q_CAROUSELS);
    const slideRows = await source.query<RawCarouselSlideRow>(Q_CAROUSEL_SLIDES);
    const resourceLinkRows = await source.query<RawResourceLinkRow>(Q_RESOURCE_LINKS);
    const settings = new Map(appSettingRows.map((r) => [r.SettingName, r.SettingValue]));

    await importCarousels(tx, carouselRows, slideRows, now, report);
    await importResourceLinks(tx, resourceLinkRows, report);
    await importPins(tx, settings, slideRows, now, report);

    const liveFeedEnabled = isGranvilleOn(settings.get("live_webcast_enabled"));
    const granville = normalizeGranville(settings.get("granville"));
    const desired = { liveFeedEnabled, liveManifestUrl: "", liveM3uUrl: "", granville };
    const changed =
      settingsRow.liveFeedEnabled !== desired.liveFeedEnabled ||
      settingsRow.liveManifestUrl !== desired.liveManifestUrl ||
      settingsRow.liveM3uUrl !== desired.liveM3uUrl ||
      settingsRow.granville !== desired.granville;

    let resultingVersion = settingsRow.version;
    if (changed) {
      resultingVersion = settingsRow.version + 1;
      await tx.update(siteSettings).set({ ...desired, version: resultingVersion, updatedAt: now }).where(eq(siteSettings.id, 1));
      if (granville === "true") {
        await tx.insert(siteLog).values({ actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, area: "blue-bridge", text: "Imported Project Blue Bridge as ON", at: now });
      }
    }

    await tx.update(siteSettings).set({ websiteImportedAt: now, websiteImportedVersion: resultingVersion }).where(eq(siteSettings.id, 1));

    return { skipped: false };
  });
}
