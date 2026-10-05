/**
 * Phase 3e (NRMS legacy importer, spec §8, task 4): carousels and their slides, the two
 * emergency pins, the Live Feed on/off flag, Project Blue Bridge's `granville` text and the
 * resource links — the "website" half of the legacy site (everything in migration 0012's
 * tables). See .superpowers/sdd/2026-10-04-phase-3e-nrms-importer/task-4-brief.md.
 *
 * Carousels, their slides and the resource links have no legacy-id column of their own (see
 * codemap.md §3), so a write replaces all three wholesale, in this function's own transaction,
 * rather than diffing row by row — which would give them fresh ids on every write. Fix round 1
 * (spec acceptance 15 — a re-run against unchanged legacy data must change nothing): before
 * writing anything, the whole mapped bundle (carousel states/go-live times/slides including an
 * image-bytes digest, both pins, the Live Feed flag, `granville`, and the links) is hashed and
 * compared to `site_settings.website_import_hash`. An equal hash makes this call a complete
 * no-op — no writes anywhere, report counts still "imported" — so wholesale-replaced tables only
 * get fresh ids when something legacy-sourced actually changed. `site_settings` (Live Feed +
 * `granville`) and the two seeded `emergency_pins` rows additionally have a stable identity of
 * their own (a singleton row, and the fixed slots `primary`/`secondary`), so even on a write
 * those are compared against their current content and only versioned when THEY changed — an
 * unrelated change elsewhere (e.g. a new carousel) doesn't bump an untouched pin's version.
 *
 * Fix round 1, finding 2: resource_links is wholesale-replaced (fresh ids) on every write, which
 * invalidates any id an editor's open links page is holding — so every write also bumps
 * `site_settings.links_version` (the links editor's optimistic-concurrency token,
 * apps/nrms/src/website/links.ts), regardless of whether the links themselves changed.
 *
 * No events: this importer never calls `emitSite`/`enqueueEvent` (the News API's own importer
 * already carries this content to the public site from its own copy of the legacy data).
 */
import { createHash } from "node:crypto";
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

// --- Stable hashing (fix round 1): a deterministic digest of the whole mapped bundle, so an
// unchanged re-run can be detected without comparing every column of every row by hand. Image
// bytes are reduced to a sha256 digest first (never embedded raw) so the hash input stays small
// and JSON-safe. ---
function imageDigest(image: Buffer | null): string | null {
  return image ? createHash("sha256").update(image).digest("hex") : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

function hashableSlide(s: { sortIndex: number } & SlideFields): Record<string, unknown> {
  return { sortIndex: s.sortIndex, headline: s.headline, summary: s.summary, actionUrl: s.actionUrl, facebookPostUrl: s.facebookPostUrl, justify: s.justify, imageDigest: imageDigest(s.image) };
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

// --- Carousel + slide plan (pure): decides, for every legacy carousel/slide row, whether it's
// imported or skipped (and why) — computed once, then shared by the report, the hash and the
// actual write, so those three can never disagree with each other. ---
interface SelectedCarousel {
  row: RawCarouselRow;
  state: "live" | "next" | "past";
  slides: ({ sortIndex: number } & SlideFields)[];
}
interface CarouselSlidePlan {
  selected: SelectedCarousel[];
  legacyCarouselCount: number;
  carouselSkips: { legacyId: string; reason: string }[];
  legacySlideCount: number;
  slideSkips: { legacyId: string; reason: string }[];
}

function buildCarouselSlidePlan(carouselRows: RawCarouselRow[], slideRows: RawCarouselSlideRow[], plan: CarouselPlan): CarouselSlidePlan {
  const selectedList: { row: RawCarouselRow; state: "live" | "next" | "past" }[] = [
    ...(plan.live ? [{ row: plan.live, state: "live" as const }] : []),
    ...(plan.next ? [{ row: plan.next, state: "next" as const }] : []),
    ...plan.past.map((row) => ({ row, state: "past" as const })),
  ];
  const selectedIds = new Set(selectedList.map((s) => s.row.Id.toLowerCase()));
  const skipReasonById = new Map(plan.skipped.map(({ row, reason }) => [row.Id.toLowerCase(), reason]));
  const slidesByCarousel = groupBy(slideRows, (r) => r.CarouselId);

  const carouselSkips = plan.skipped.map(({ row, reason }) => ({ legacyId: row.Id.toLowerCase(), reason }));
  const slideSkips: { legacyId: string; reason: string }[] = [];
  let legacySlideCount = 0;

  const selected: SelectedCarousel[] = selectedList.map(({ row, state }) => {
    const legacySlides = [...(slidesByCarousel.get(row.Id.toLowerCase()) ?? [])].sort((a, b) => a.SortIndex - b.SortIndex);
    const slides: ({ sortIndex: number } & SlideFields)[] = [];
    let sortIndex = 0;
    for (const s of legacySlides) {
      legacySlideCount++;
      if (s.SortIndex < 0) {
        slideSkips.push({ legacyId: `${row.Id.toLowerCase()}:${s.SlideId.toLowerCase()}`, reason: "pinned slide (SortIndex < 0), not a carousel slide" });
        continue;
      }
      slides.push({ sortIndex: sortIndex++, ...slideFields(s) });
    }
    return { row, state, slides };
  });

  for (const row of carouselRows) {
    if (selectedIds.has(row.Id.toLowerCase())) continue;
    const reason = skipReasonById.get(row.Id.toLowerCase());
    if (!reason) continue;
    for (const s of slidesByCarousel.get(row.Id.toLowerCase()) ?? []) {
      legacySlideCount++;
      slideSkips.push({ legacyId: `${row.Id.toLowerCase()}:${s.SlideId.toLowerCase()}`, reason: `carousel skipped: ${reason}` });
    }
  }

  return { selected, legacyCarouselCount: carouselRows.length, carouselSkips, legacySlideCount, slideSkips };
}

function reportCarouselSlidePlan(report: ImportReport, plan: CarouselSlidePlan): void {
  for (let i = 0; i < plan.legacyCarouselCount; i++) report.count("carousels", "legacy");
  for (let i = 0; i < plan.selected.length; i++) report.count("carousels", "imported");
  for (const { legacyId, reason } of plan.carouselSkips) report.skip("carousels", legacyId, reason);

  for (let i = 0; i < plan.legacySlideCount; i++) report.count("slides", "legacy");
  const importedSlides = plan.selected.reduce((n, s) => n + s.slides.length, 0);
  for (let i = 0; i < importedSlides; i++) report.count("slides", "imported");
  for (const { legacyId, reason } of plan.slideSkips) report.skip("slides", legacyId, reason);
}

function hashableCarousel(s: SelectedCarousel): Record<string, unknown> {
  return {
    state: s.state,
    publishDateTime: s.row.PublishDateTime ? s.row.PublishDateTime.toISOString() : null,
    slides: s.slides.map(hashableSlide),
  };
}

async function applyCarouselSlidePlan(tx: Tx, plan: CarouselSlidePlan): Promise<void> {
  // Wholesale replace: carousels have no legacy-id column to diff against, so a write deletes
  // and reinserts (cascading to `slides`) rather than trying to match old rows by content.
  await tx.delete(carousels);
  for (const s of plan.selected) {
    const [created] = await tx
      .insert(carousels)
      .values({
        state: s.state,
        goLiveAt: s.state === "next" ? s.row.PublishDateTime : null,
        wentLiveAt: s.state === "next" ? null : s.row.PublishDateTime,
      })
      .returning({ id: carousels.id });
    if (s.slides.length) {
      await tx.insert(websiteSlides).values(s.slides.map((sl) => ({ carouselId: created!.id, ...sl })));
    }
  }
}

// --- Resource links (pure plan + report + write, same three-way split as carousels). ---
interface LinkPlanRow {
  sortIndex: number;
  text: string;
  url: string;
}

function buildLinksPlan(rows: RawResourceLinkRow[]): LinkPlanRow[] {
  return [...rows].sort((a, b) => a.SortIndex - b.SortIndex).map((r) => ({ sortIndex: r.SortIndex, text: r.LinkText ?? "", url: r.LinkUrl ?? "" }));
}

function reportLinksPlan(report: ImportReport, rows: RawResourceLinkRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    report.count("resource_links", "legacy");
    report.count("resource_links", "imported");
  }
}

async function applyLinksPlan(tx: Tx, plan: LinkPlanRow[]): Promise<void> {
  await tx.delete(websiteResourceLinks);
  if (plan.length) await tx.insert(websiteResourceLinks).values(plan);
}

// --- Emergency pins (task-4 brief): legacy's exact ApplicationSetting keys, from
// Hub.Legacy.Website/News/EmergencySlideManagement.aspx.cs:16-21/45-50 — a pinned slide is a
// CarouselSlide row with SortIndex < 0 inside the carousel named by PinnedCarouselId /
// SecondaryCarouselId. `resolvePins` is pure (no DB access): an unpinned slot contributes
// nothing legacy-sourced beyond "not pinned" — whatever content currently sits in that row is
// NRMS's own state, not legacy's, so it's left alone (and never hashed) rather than read here. ---
const PIN_SETTINGS = {
  primary: { isPinned: "IsPinnedSlide", slideId: "PinnedSlideId", carouselId: "PinnedCarouselId" },
  secondary: { isPinned: "IsPinnedSecondarySlide", slideId: "SecondarySlideId", carouselId: "SecondaryCarouselId" },
} as const;
type PinSlot = keyof typeof PIN_SETTINGS;

interface PinPlan {
  pinned: boolean;
  content: SlideFields | null;
  warn?: { legacyId: string; key: string; problems: string[] };
}

function resolvePins(settings: Map<string, string>, slideRows: RawCarouselSlideRow[]): Record<PinSlot, PinPlan> {
  const bySlideCarousel = new Map(slideRows.map((r) => [`${r.CarouselId.toLowerCase()}\u0000${r.SlideId.toLowerCase()}`, r]));
  const result = {} as Record<PinSlot, PinPlan>;

  for (const slot of ["primary", "secondary"] as const) {
    const names = PIN_SETTINGS[slot];
    const flagged = isGranvilleOn(settings.get(names.isPinned));
    const slideIdRaw = settings.get(names.slideId);
    const carouselIdRaw = settings.get(names.carouselId);

    let match: RawCarouselSlideRow | undefined;
    if (flagged && slideIdRaw && carouselIdRaw) {
      match = bySlideCarousel.get(`${carouselIdRaw.toLowerCase()}\u0000${slideIdRaw.toLowerCase()}`);
    }
    const pinned = flagged && Boolean(match);
    const plan: PinPlan = { pinned, content: pinned ? slideFields(match!) : null };
    if (flagged && !match) {
      plan.warn = { legacyId: slideIdRaw ?? slot, key: `pin:${slot}`, problems: ["pinned slide setting points at an unknown carousel/slide — left unpinned"] };
    }
    result[slot] = plan;
  }
  return result;
}

function reportPinWarnings(report: ImportReport, pins: Record<PinSlot, PinPlan>): void {
  for (const slot of ["primary", "secondary"] as const) {
    const w = pins[slot].warn;
    if (w) report.warn(w.legacyId, w.key, w.problems);
  }
}

function hashablePin(p: PinPlan): Record<string, unknown> {
  if (!p.pinned || !p.content) return { pinned: false };
  return { pinned: true, headline: p.content.headline, summary: p.content.summary, actionUrl: p.content.actionUrl, facebookPostUrl: p.content.facebookPostUrl, justify: p.content.justify, imageDigest: imageDigest(p.content.image) };
}

async function applyPinsPlan(tx: Tx, pins: Record<PinSlot, PinPlan>, now: Date): Promise<void> {
  for (const slot of ["primary", "secondary"] as const) {
    const plan = pins[slot];
    const [current] = await tx.select().from(emergencyPins).where(eq(emergencyPins.slot, slot)).for("update");
    if (!current) throw new Error(`emergency_pins has no seeded row for slot ${slot} — migration 0012 should have seeded both slots`);

    const desired: { pinned: boolean } & SlideFields = plan.content
      ? { pinned: true, ...plan.content }
      : { pinned: false, headline: current.headline, summary: current.summary, actionUrl: current.actionUrl, facebookPostUrl: current.facebookPostUrl, justify: current.justify, image: current.image, imageType: current.imageType };

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

async function dbNow(tx: Tx): Promise<Date> {
  // Constraints: "now" for live/next/past decisions is the DB clock, not Date.now() (same idiom
  // as releases/workflow.ts's dbClock — the driver can hand this back as a string).
  const r = await tx.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
  return new Date(r.rows[0]!.now);
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

    const now = await dbNow(tx);

    const appSettingRows = await source.query<RawAppSettingRow>(Q_APP_SETTINGS);
    const carouselRows = await source.query<RawCarouselRow>(Q_CAROUSELS);
    const slideRows = await source.query<RawCarouselSlideRow>(Q_CAROUSEL_SLIDES);
    const resourceLinkRows = await source.query<RawResourceLinkRow>(Q_RESOURCE_LINKS);
    const settings = new Map(appSettingRows.map((r) => [r.SettingName, r.SettingValue]));

    const carouselPlan = planCarousels(carouselRows, now);
    const slidePlan = buildCarouselSlidePlan(carouselRows, slideRows, carouselPlan);
    const linksPlan = buildLinksPlan(resourceLinkRows);
    const pinsPlan = resolvePins(settings, slideRows);
    const liveFeedEnabled = isGranvilleOn(settings.get("live_webcast_enabled"));
    const granville = normalizeGranville(settings.get("granville"));

    // Report counts and warnings reflect the legacy data either way — even a hash-matched
    // no-op run below still reports every legacy row as "imported" (spec acceptance 15).
    reportCarouselSlidePlan(report, slidePlan);
    reportLinksPlan(report, resourceLinkRows);
    reportPinWarnings(report, pinsPlan);

    const bundleHash = sha256({
      carousels: slidePlan.selected.map(hashableCarousel),
      pins: { primary: hashablePin(pinsPlan.primary), secondary: hashablePin(pinsPlan.secondary) },
      liveFeedEnabled,
      granville,
      links: linksPlan,
    });

    // Fix round 1 (spec acceptance 15): an unchanged bundle makes no writes at all — no fresh
    // ids for the wholesale-replaced tables, no version bumps, no site_log rows. `force`
    // bypasses this too: its whole purpose is to reassert legacy content regardless of what's
    // currently in NRMS, including reverting a local edit the hash can't see (the hash is a
    // function of legacy data only, so it would otherwise match and silently no-op).
    if (!opts.force && settingsRow.websiteImportHash === bundleHash) {
      return { skipped: false };
    }

    await applyCarouselSlidePlan(tx, slidePlan);
    await applyLinksPlan(tx, linksPlan);
    await applyPinsPlan(tx, pinsPlan, now);

    const desiredSettings = { liveFeedEnabled, liveManifestUrl: "", liveM3uUrl: "", granville };
    const settingsChanged =
      settingsRow.liveFeedEnabled !== desiredSettings.liveFeedEnabled ||
      settingsRow.liveManifestUrl !== desiredSettings.liveManifestUrl ||
      settingsRow.liveM3uUrl !== desiredSettings.liveM3uUrl ||
      settingsRow.granville !== desiredSettings.granville;
    const resultingVersion = settingsChanged ? settingsRow.version + 1 : settingsRow.version;

    await tx
      .update(siteSettings)
      .set({
        ...desiredSettings,
        version: resultingVersion,
        // Fix round 1, finding 2: resource_links was just rewritten with fresh ids above, which
        // invalidates any id an editor's open links page is holding — bump links_version every
        // time that write happens, regardless of whether the links' own content changed.
        linksVersion: settingsRow.linksVersion + 1,
        websiteImportHash: bundleHash,
        websiteImportedAt: now,
        websiteImportedVersion: resultingVersion,
        updatedAt: now,
      })
      .where(eq(siteSettings.id, 1));

    if (settingsChanged && granville === "true") {
      await tx.insert(siteLog).values({ actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, area: "blue-bridge", text: "Imported Project Blue Bridge as ON", at: now });
    }

    return { skipped: false };
  });
}
