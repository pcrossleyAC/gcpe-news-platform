import { and, eq, isNotNull, or } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { LANG_EN, type FeatureKind, type FeatureSlot, type ReleaseView } from "@gcpe/nrms-contract";
import { categoryFeatures, categoryTerms, documentLanguages, newsReleases, organizations, releaseCategories, releaseDocuments } from "../db/schema";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError } from "../releases/errors";
import { loadView, writeLog, type Actor } from "../releases/store";
import { emitSite, writeSiteLog } from "./events";

/**
 * Top/Feature slots for releases (plan 3d task 5). See
 * .superpowers/sdd/2026-10-04-phase-3d-website-section/task-5-brief.md.
 */

export interface SetFeatureInput {
  kind: FeatureKind;
  key: string;
  slot: FeatureSlot;
  on: boolean;
}

const SLOT_LABEL: Record<FeatureSlot, string> = { top: "Top", feature: "Feature" };

function placeLabel(kind: FeatureKind, key: string): string {
  return kind === "home" ? "Home" : `${kind}/${key}`;
}

function slotColumn(row: { topReleaseId: string | null; featureReleaseId: string | null } | undefined, slot: FeatureSlot): string | null {
  if (!row) return null;
  return slot === "top" ? row.topReleaseId : row.featureReleaseId;
}

/**
 * Sets or clears a Top/Feature slot. `on: true` always takes the slot over — whatever release
 * held it before is simply no longer referenced by `category_features`, so it drops out of its
 * own `view.features` (spec §6.5). `on: false` only clears the slot when this release holds it.
 */
export async function setFeature(db: Db, releaseId: string, input: SetFeatureInput, actor: Actor, subs: SubscriberConfig[]): Promise<ReleaseView> {
  const { kind, key, slot, on } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(newsReleases).where(eq(newsReleases.id, releaseId)).for("update");
    if (!row) throw new ReleaseNotFoundError(releaseId);
    if (row.status !== "published") throw new ReleaseStateError("Only a published release can be Top or Feature.");
    if (kind !== "home") {
      const [cat] = await tx
        .select()
        .from(releaseCategories)
        .where(and(eq(releaseCategories.releaseId, releaseId), eq(releaseCategories.kind, kind), eq(releaseCategories.key, key)));
      if (!cat) throw new ReleaseRuleError(["This release isn't in that category."]);
    }

    const [existing] = await tx.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key))).for("update");
    const holds = slotColumn(existing, slot) === releaseId;

    let changed = false;
    if (on) {
      if (!holds) {
        if (existing) {
          if (slot === "top") await tx.update(categoryFeatures).set({ topReleaseId: releaseId }).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key)));
          else await tx.update(categoryFeatures).set({ featureReleaseId: releaseId }).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key)));
        } else if (slot === "top") {
          await tx.insert(categoryFeatures).values({ kind, key, topReleaseId: releaseId });
        } else {
          await tx.insert(categoryFeatures).values({ kind, key, featureReleaseId: releaseId });
        }
        changed = true;
      }
    } else if (holds) {
      if (slot === "top") await tx.update(categoryFeatures).set({ topReleaseId: null }).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key)));
      else await tx.update(categoryFeatures).set({ featureReleaseId: null }).where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key)));
      changed = true;
    }

    if (changed) {
      const text = `${on ? "Set as" : "Removed as"} ${SLOT_LABEL[slot]} for ${placeLabel(kind, key)}`;
      await writeLog(tx, releaseId, actor, text);
      await writeSiteLog(tx, actor, "features", text);
      await emitSite(tx, subs, kind === "home" ? "home" : { kind, key });
    }
    return (await loadView(tx, releaseId))!;
  });
}

/**
 * Empties every slot the release holds and emits the affected kind/key's snapshot for each one.
 * Called in the publisher's unpublish transaction and in `deleteRelease` — both places that can
 * take a release off the public site. A release that holds nothing is a no-op: no event.
 */
export async function clearFeaturesFor(tx: Tx, releaseId: string, subs: SubscriberConfig[]): Promise<void> {
  const rows = await tx.select().from(categoryFeatures).where(or(eq(categoryFeatures.topReleaseId, releaseId), eq(categoryFeatures.featureReleaseId, releaseId)));
  for (const row of rows) {
    const clearTop = row.topReleaseId === releaseId;
    const clearFeature = row.featureReleaseId === releaseId;
    await tx
      .update(categoryFeatures)
      .set({ ...(clearTop ? { topReleaseId: null } : {}), ...(clearFeature ? { featureReleaseId: null } : {}) })
      .where(and(eq(categoryFeatures.kind, row.kind), eq(categoryFeatures.key, row.key)));
    await emitSite(tx, subs, row.kind === "home" ? "home" : { kind: row.kind, key: row.key });
  }
}

export interface FeaturedWhereRow {
  kind: FeatureKind;
  key: string;
  label: string;
  top: { id: string; key: string; headline: string } | null;
  feature: { id: string; key: string; headline: string } | null;
}

async function releaseBrief(db: DbOrTx, releaseId: string | null): Promise<{ id: string; key: string; headline: string } | null> {
  if (!releaseId) return null;
  const [row] = await db
    .select({ id: newsReleases.id, key: newsReleases.key, headline: documentLanguages.headline })
    .from(newsReleases)
    .innerJoin(releaseDocuments, and(eq(releaseDocuments.releaseId, newsReleases.id), eq(releaseDocuments.sortIndex, 0)))
    .innerJoin(documentLanguages, and(eq(documentLanguages.documentId, releaseDocuments.id), eq(documentLanguages.languageId, LANG_EN)))
    .where(eq(newsReleases.id, releaseId));
  if (!row) return null;
  return { id: row.id, key: row.key ?? row.id, headline: row.headline };
}

/** Every `category_features` row with a slot set — home first, then by kind and label. */
export async function featuredWhere(db: DbOrTx): Promise<FeaturedWhereRow[]> {
  const rows = await db.select().from(categoryFeatures).where(or(isNotNull(categoryFeatures.topReleaseId), isNotNull(categoryFeatures.featureReleaseId)));
  const orgs = await db.select().from(organizations);
  const terms = await db.select().from(categoryTerms);
  const labelOf = (kind: FeatureKind, key: string): string => {
    if (kind === "home") return "Home";
    if (kind === "ministries") return orgs.find((o) => o.key === key)?.displayName ?? key;
    return terms.find((t) => t.kind === kind && t.key === key)?.displayName ?? key;
  };

  const out: FeaturedWhereRow[] = [];
  for (const row of rows) {
    out.push({
      kind: row.kind,
      key: row.key,
      label: labelOf(row.kind, row.key),
      top: await releaseBrief(db, row.topReleaseId),
      feature: await releaseBrief(db, row.featureReleaseId),
    });
  }
  out.sort((a, b) => {
    if (a.kind === "home" || b.kind === "home") return a.kind === b.kind ? 0 : a.kind === "home" ? -1 : 1;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
  return out;
}
