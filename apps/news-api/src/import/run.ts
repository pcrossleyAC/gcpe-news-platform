import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import type { LegacySource } from "@gcpe/legacy-import";
import { applyRelease, applySiteContent } from "../projections";
import { imageTypeFromBytes, justifyFromLegacy, mapLegacyRelease, type LegacyContactRow, type LegacyDocumentRow, type LegacyIndexRow, type LegacyReleaseRow } from "./map";
import { Q_APP_SETTINGS, Q_CATEGORY_FEATURES, Q_CURRENT_SLIDES, Q_RELEASE_KEYS_BY_ID, Q_RELEASE_YEARS, Q_RESOURCE_LINKS, qContacts, qDocuments, qReleaseIndexes, qReleases } from "./queries";

const lower = (s: string) => s.toLowerCase();

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

export async function importLegacyNews(
  db: Db,
  source: LegacySource,
  opts: {
    log?: (msg: string) => void;
    allowEmptySlides?: boolean;
    /**
     * After importing, unpublish every post still published here whose key isn't in legacy's
     * published set (it was unpublished/deactivated in legacy since the last import). Default
     * true: the importer is always a full import. Skipped when legacy returned no releases.
     */
    unpublishMissing?: boolean;
  } = {},
): Promise<{ releases: number; slides: number; resourceLinks: number; features: number; unpublished: number }> {
  const log = opts.log ?? (() => {});
  const result = { releases: 0, slides: 0, resourceLinks: 0, features: 0, unpublished: 0 };
  const importedKeys: string[] = [];

  const years = (await source.query<{ Year: number }>(Q_RELEASE_YEARS)).map((r) => r.Year).sort();
  for (const y of years) {
    const releases = await source.query<LegacyReleaseRow>(qReleases(y));
    const docs = groupBy(await source.query<LegacyDocumentRow>(qDocuments(y)), (r) => lower(r.ReleaseId));
    const allContacts = await source.query<LegacyContactRow>(qContacts(y));
    const indexes = groupBy(await source.query<LegacyIndexRow>(qReleaseIndexes(y)), (r) => lower(r.ReleaseId));
    const contactsByDoc = groupBy(allContacts, (c) => lower(c.DocumentId));
    for (const row of releases) {
      const id = lower(row.Id);
      const releaseDocs = docs.get(id) ?? [];
      const contacts = releaseDocs.flatMap((d) => contactsByDoc.get(lower(d.DocumentId)) ?? []);
      const record = mapLegacyRelease(row, releaseDocs, contacts, indexes.get(id) ?? []);
      // No per-release PostUpdate: see ApplyOptions.notify and the README's import notes.
      // origin: "legacy" marks this row as legacy-owned, so unpublish-missing below may later
      // unpublish it if legacy stops publishing it. An NRMS event for the same key flips it
      // to "event" (see ApplyOptions.origin) and this importer can never touch it again.
      await db.transaction((tx) => applyRelease(tx, record, { notify: false, origin: "legacy" }));
      importedKeys.push(record.key);
      result.releases++;
    }
    log(`year ${y}: ${releases.length} releases`);
  }

  if (opts.unpublishMissing !== false) {
    if (importedKeys.length === 0) {
      // An empty published set is far likelier to be a broken/empty source than legacy
      // genuinely having nothing published — never let it unpublish the whole store.
      log("[import] legacy returned no published releases; skipping unpublish of missing posts");
    } else {
      // One JSON parameter rather than one bind parameter per key (~100k keys would blow
      // Postgres's 65535-parameter limit). Also silent: no PostUpdate, as for the upserts.
      // origin = 'legacy' only: an 'event' row is NRMS-owned (it published or was later
      // re-published there even if legacy first created it), and legacy not listing it here
      // must never unpublish it.
      const { rows } = await db.execute<{ key: string }>(sql`
        UPDATE posts SET is_published = false
        WHERE is_published
          AND origin = 'legacy'
          AND lower(key) NOT IN (SELECT lower(value) FROM jsonb_array_elements_text(${JSON.stringify(importedKeys)}::jsonb))
        RETURNING key`);
      result.unpublished = rows.length;
      log(`[import] unpublished ${rows.length} post(s) no longer published in legacy`);
    }
  }

  const keyById = new Map((await source.query<{ Id: string; Key: string }>(Q_RELEASE_KEYS_BY_ID)).map((r) => [lower(r.Id), r.Key]));
  const keyFor = (id: string | null | undefined) => (id ? (keyById.get(lower(id)) ?? null) : null);

  const settings = new Map((await source.query<{ SettingName: string; SettingValue: string }>(Q_APP_SETTINGS)).map((s) => [s.SettingName, s.SettingValue]));
  await db.transaction((tx) =>
    applySiteContent(tx, {
      entity: "home",
      topPostKey: keyFor(settings.get("HomeTopReleaseId")),
      featurePostKey: keyFor(settings.get("HomeFeatureReleaseId")),
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: settings.get("granville") ?? null,
      timestamp: new Date().toISOString(),
    }),
  );

  for (const f of await source.query<{ Kind: CategoryKind; Key: string; TopReleaseId: string | null; FeatureReleaseId: string | null }>(Q_CATEGORY_FEATURES)) {
    await db.transaction((tx) =>
      applySiteContent(tx, { entity: "categoryFeatures", kind: f.Kind, key: f.Key, topPostKey: keyFor(f.TopReleaseId), featurePostKey: keyFor(f.FeatureReleaseId) }),
    );
    // Every Ministry/Sector/Theme row is applied (so a pointer legacy cleared clears ours
    // too), but the reported count only reflects rows that actually carry a feature.
    if (f.TopReleaseId !== null || f.FeatureReleaseId !== null) result.features++;
  }

  const slideRows = await source.query<{
    Id: string;
    SortIndex: number;
    Headline: string | null;
    Summary: string | null;
    ActionUrl: string | null;
    Image: Buffer | null;
    FacebookPostUrl: string | null;
    Justify: number | null;
    Timestamp: Date;
  }>(Q_CURRENT_SLIDES);
  // An empty result just means "no carousel is currently live" (e.g. between
  // carousels), not "delete every slide" — applySiteContent("slides") replaces the
  // whole table, so skip it rather than wipe existing slides on a transient gap.
  if (slideRows.length > 0 || opts.allowEmptySlides === true) {
    await db.transaction((tx) =>
      applySiteContent(tx, {
        entity: "slides",
        slides: slideRows.map((s) => ({
          id: lower(s.Id),
          sortIndex: s.SortIndex,
          headline: s.Headline,
          summary: s.Summary,
          actionLabel: null,
          actionUri: s.ActionUrl,
          imageBase64: s.Image ? s.Image.toString("base64") : null,
          imageType: imageTypeFromBytes(s.Image),
          facebookPostUri: s.FacebookPostUrl,
          justify: justifyFromLegacy(s.Justify),
          timestamp: s.Timestamp.toISOString(),
        })),
      }),
    );
  } else {
    log("[import] no current carousel slides found; existing slides kept");
  }
  result.slides = slideRows.length;

  const links = await source.query<{ SortIndex: number; LinkText: string; LinkUrl: string }>(Q_RESOURCE_LINKS);
  await db.transaction((tx) =>
    applySiteContent(tx, {
      entity: "resourceLinks",
      links: links.map((l) => ({ sortIndex: l.SortIndex, text: l.LinkText, uri: l.LinkUrl })),
      timestamp: new Date().toISOString(),
    }),
  );
  result.resourceLinks = links.length;
  return result;
}
