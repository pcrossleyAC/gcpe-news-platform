import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { siteSettings, websiteResourceLinks } from "../db/schema";
import type { Actor } from "../releases/store";
import { emitSite, writeSiteLog } from "./events";
import { SiteConflictError, SiteRuleError } from "./errors";

/**
 * The resource links list (plan 3d task 3). See
 * .superpowers/sdd/2026-10-04-phase-3d-website-section/task-3-brief.md.
 */

export interface ResourceLinkView {
  id: string;
  text: string;
  url: string;
}

export interface LinksView {
  /** `site_settings.links_version` — the optimistic-concurrency token for the whole list. */
  version: number;
  links: ResourceLinkView[];
}

export interface LinkInput {
  id?: string;
  text: string;
  url: string;
}

export interface SaveLinksInput {
  version: number;
  links: LinkInput[];
}

const MAX_TEXT = 255;
const MAX_URL = 255;

/** constraints.md §6.1: `http(s)` absolute, or site-relative starting with `/`. */
function urlOk(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url) || url.startsWith("/");
}

async function orderedLinks(tx: DbOrTx): Promise<ResourceLinkView[]> {
  const rows = await tx.select().from(websiteResourceLinks).orderBy(asc(websiteResourceLinks.sortIndex));
  return rows.map((r) => ({ id: r.id, text: r.text, url: r.url }));
}

export async function getLinks(db: DbOrTx): Promise<LinksView> {
  const [settings] = await db.select({ version: siteSettings.linksVersion }).from(siteSettings).where(eq(siteSettings.id, 1));
  return { version: settings?.version ?? 1, links: await orderedLinks(db) };
}

/**
 * Replaces the whole ordered list: existing ids keep their row (new `sort_index` = position),
 * an id not already in the table is refused, and ids left out are deleted. Checked against
 * `site_settings.links_version`, which this bumps along with `updated_at` (the controller
 * ruling: `linksSnapshot` takes its timestamp from `site_settings.updated_at`).
 */
export async function saveLinks(db: Db, input: SaveLinksInput, actor: Actor, subs: SubscriberConfig[]): Promise<LinksView> {
  for (const l of input.links) {
    if (l.text.length > MAX_TEXT) throw new SiteRuleError([`"${l.text.slice(0, 40)}" needs text of 255 characters or fewer.`]);
    if (l.url.length > MAX_URL || !urlOk(l.url)) throw new SiteRuleError([`"${l.text}" needs an http(s) URL or one starting with "/".`]);
  }

  return db.transaction(async (tx) => {
    const [settings] = await tx.select({ version: siteSettings.linksVersion }).from(siteSettings).where(eq(siteSettings.id, 1)).for("update");
    if (!settings) throw new Error("site_settings has no row — the website migration should have inserted id=1");
    if (settings.version !== input.version) throw new SiteConflictError();

    const existing = await tx.select({ id: websiteResourceLinks.id }).from(websiteResourceLinks);
    const existingIds = new Set(existing.map((r) => r.id));
    for (const l of input.links) {
      if (l.id && !existingIds.has(l.id)) throw new SiteRuleError([`Unknown link: ${l.id}`]);
    }

    const keepIds = new Set(input.links.filter((l) => l.id).map((l) => l.id!));
    const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
    if (toDelete.length) await tx.delete(websiteResourceLinks).where(inArray(websiteResourceLinks.id, toDelete));

    for (let i = 0; i < input.links.length; i++) {
      const l = input.links[i]!;
      if (l.id) {
        await tx.update(websiteResourceLinks).set({ sortIndex: i, text: l.text, url: l.url }).where(eq(websiteResourceLinks.id, l.id));
      } else {
        await tx.insert(websiteResourceLinks).values({ sortIndex: i, text: l.text, url: l.url });
      }
    }

    const [updatedSettings] = await tx
      .update(siteSettings)
      .set({ linksVersion: settings.version + 1, updatedAt: sql`now()` })
      .where(eq(siteSettings.id, 1))
      .returning();

    await writeSiteLog(tx, actor, "links", `Saved ${input.links.length} resource links`);
    await emitSite(tx, subs, "links");

    return { version: updatedSettings!.linksVersion, links: await orderedLinks(tx) };
  });
}
