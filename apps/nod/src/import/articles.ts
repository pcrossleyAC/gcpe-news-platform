import { eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { POST_KIND, type ReleaseType } from "@gcpe/nrms-contract";
import { emergencyItemKey } from "../as-it-happens";
import { items, nodSettings } from "../db/schema";
import { deliveryModes, EMERGENCY_CATEGORY_KEY, guidKey, type ListMapping, type MappedList } from "./map";
import { qArticleLists, qArticles, qSubscriberArticles, Q_DIGEST_END } from "./queries";
import type { NodImportReport } from "./report";
import type { ImportedSubscriber } from "./subscribers";

/** Stamped on every imported delivery as its Distribution batch: the reports count it as handed
 * off (legacy sent it), and no delivery.bounced event can ever carry it. */
export const LEGACY_BATCH_ID = "00000000-0000-4000-8000-0000001e9ac7";
const INSERT_CHUNK = 5_000;

/** NRMS's release key and post kind for each legacy Article id: the AtomId, or "uuid:" + the
 * legacy NewsRelease.Id (Hub's GetAtomId). Read-only. */
export async function nrmsReleaseIndex(nrms: Db): Promise<Map<string, { key: string; postKind: string }>> {
  const { rows } = await nrms.execute<{ key: string; type: ReleaseType; atom_id: string | null; legacy_id: string | null }>(
    sql`SELECT key, type, atom_id, legacy_id FROM news_releases WHERE key IS NOT NULL`,
  );
  const index = new Map<string, { key: string; postKind: string }>();
  for (const r of rows) {
    const v = { key: r.key, postKind: POST_KIND[r.type] };
    if (r.atom_id) index.set(r.atom_id.trim().toLowerCase(), v);
    if (r.legacy_id) index.set(`uuid:${r.legacy_id.toLowerCase()}`, v);
  }
  return index;
}

interface LegacyArticleRow {
  ArticleGuid: string;
  ArticleSourceID: string;
  RelativeUri: string | null;
  PublishDateTimeUtc: Date | null;
  IsDeleted: boolean;
  Title: string | null;
}

interface ItemPlan {
  row: typeof items.$inferInsert & { publishedAt: Date };
  kind: "release" | "emergency";
  mediaListKeys: string[];
}

export interface ArticleStageContext {
  report: NodImportReport;
  lists: ListMapping;
  subscribers: Map<string, ImportedSubscriber>;
  sinceDays: number;
  publicSiteUrl: string;
}

function planItem(a: LegacyArticleRow, listGuids: string[], releases: Map<string, { key: string; postKind: string }>, ctx: ArticleStageContext): ItemPlan | { skip: string } {
  if (a.IsDeleted) return { skip: "deleted in legacy" };
  if (!a.PublishDateTimeUtc) return { skip: "never published" };
  const categories = listGuids.map((g) => ctx.lists.categoryOf.get(g));
  const mapped = listGuids.map((g) => ctx.lists.byGuid.get(g)).filter((m): m is MappedList => m !== undefined);
  const publicKeys = [...new Set(mapped.filter((m) => !m.media).map((m) => m.listKey))].sort();
  const mediaKeys = [...new Set(mapped.filter((m) => m.media).map((m) => m.listKey))].sort();
  const title = (a.Title ?? "").replace(/\s+/g, " ").trim();
  if (categories.includes(EMERGENCY_CATEGORY_KEY)) {
    const url = (a.RelativeUri ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return { skip: "emergency alert without a link" };
    return {
      kind: "emergency",
      mediaListKeys: [],
      row: { key: emergencyItemKey(a.ArticleSourceID), kind: "emergency", postKind: null, listKeys: ["emergency:alerts"], title: title || "Emergency alert", summary: "", url, publishedAt: a.PublishDateTimeUtc, toSubscribers: true },
    };
  }
  const release = releases.get(a.ArticleSourceID.trim().toLowerCase());
  if (!release) {
    return { skip: categories.some((c) => c === "newsletters" || c === "services") ? "newsletter or programs-and-services item: not carried over" : "release not found in NRMS (import NRMS first)" };
  }
  return {
    kind: "release",
    mediaListKeys: mediaKeys,
    row: {
      key: release.key,
      kind: "release",
      postKind: release.postKind,
      listKeys: publicKeys,
      mediaListKeys: mediaKeys,
      title: title || release.key,
      summary: "",
      url: `${ctx.publicSiteUrl.replace(/\/$/, "")}/releases/${encodeURIComponent(release.key)}`,
      publishedAt: a.PublishDateTimeUtc,
      toSubscribers: publicKeys.length > 0,
    },
  };
}

async function importRecipients(db: Db, source: LegacySource, articleGuid: string, plan: ItemPlan, ctx: ArticleStageContext): Promise<void> {
  const rows = await source.query<{ SubscriberGuid: string; ImmediateAttempted: boolean; DigestAttempted: boolean; HardBounced: boolean }>(qSubscriberArticles(articleGuid));
  ctx.report.count("SubscriberArticle", "legacy", rows.length);
  const ids: string[] = [];
  const modes: string[] = [];
  const hard: boolean[] = [];
  for (const r of rows) {
    const sid = guidKey(r.SubscriberGuid);
    const sub = ctx.subscribers.get(sid);
    if (!sub) {
      ctx.report.skip("SubscriberArticle", "subscriber not imported", `${sid}/${articleGuid}`);
      continue;
    }
    const ms = deliveryModes(r, sub, plan);
    if (ms.length === 0) {
      ctx.report.skip("SubscriberArticle", "no send for this subscriber's timing", `${sid}/${articleGuid}`);
      continue;
    }
    ctx.report.count("SubscriberArticle", "imported");
    for (const m of ms) {
      ids.push(sid);
      modes.push(m);
      hard.push(r.HardBounced);
    }
  }
  const at = plan.row.publishedAt.toISOString();
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    await db.execute(sql`
      INSERT INTO deliveries (item_key, subscriber_id, mode, attempted_at, distribution_batch_id, hard_bounced_at, bounce_status)
      SELECT ${plan.row.key}, t.s, t.m, ${at}::timestamptz, ${LEGACY_BATCH_ID}::uuid,
             CASE WHEN t.h THEN ${at}::timestamptz END, CASE WHEN t.h THEN 'legacy' END
        FROM unnest(${sql.param(ids.slice(i, i + INSERT_CHUNK))}::uuid[], ${sql.param(modes.slice(i, i + INSERT_CHUNK))}::text[],
                    ${sql.param(hard.slice(i, i + INSERT_CHUNK))}::boolean[]) AS t(s, m, h)
      ON CONFLICT DO NOTHING`);
  }
}

/** Legacy articles from the last `sinceDays`, as NoD items, with their recipients as deliveries.
 * NoD's own item for the same key wins; a delivery already recorded is left alone. */
export async function importArticles(db: Db, nrms: Db, source: LegacySource, ctx: ArticleStageContext): Promise<void> {
  const releases = await nrmsReleaseIndex(nrms);
  const articles = await source.query<LegacyArticleRow & Record<string, unknown>>(qArticles(ctx.sinceDays));
  const articleLists = await source.query<{ ArticleGuid: string; ListGuid: string }>(qArticleLists(ctx.sinceDays));
  ctx.report.count("Article", "legacy", articles.length);
  ctx.report.note(`Sends: articles published in legacy's last ${ctx.sinceDays} days, with their recipients; older sends are not imported.`);
  const listsOf = new Map<string, string[]>();
  for (const al of articleLists) {
    const a = guidKey(al.ArticleGuid);
    listsOf.set(a, [...(listsOf.get(a) ?? []), guidKey(al.ListGuid)]);
  }
  for (const a of articles) {
    const guid = guidKey(a.ArticleGuid);
    const plan = planItem(a, listsOf.get(guid) ?? [], releases, ctx);
    if ("skip" in plan) {
      ctx.report.skip("Article", plan.skip, guid);
      continue;
    }
    await db.insert(items).values(plan.row).onConflictDoNothing({ target: items.key });
    ctx.report.count("Article", "imported");
    await importRecipients(db, source, guid, plan, ctx);
  }
}

/** NoD's next digest starts where legacy's last one ended, never earlier than NoD's own. */
export async function importDigestCutoff(db: Db, source: LegacySource, report: NodImportReport): Promise<void> {
  const [row] = await source.query<{ ConfigValue: string | null }>(Q_DIGEST_END);
  // SQL Server writes seven fractional digits; a JS date takes three.
  const at = row?.ConfigValue ? new Date(row.ConfigValue.trim().replace(/(\.\d{3})\d+/, "$1")) : null;
  if (!at || Number.isNaN(at.getTime())) {
    report.note("Legacy's last daily digest time wasn't found: NoD's digest window is unchanged.");
    return;
  }
  await db
    .update(nodSettings)
    .set({ lastDigestCutoff: sql`GREATEST(${nodSettings.lastDigestCutoff}, ${at.toISOString()}::timestamptz)`, updatedAt: sql`now()` })
    .where(eq(nodSettings.id, 1));
  report.note(`NoD's daily digest carries on after legacy's last one (${at.toISOString()}).`);
}
