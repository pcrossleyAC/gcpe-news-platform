import { eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { siteSettings } from "../db/schema";
import type { Actor } from "../releases/store";
import { emitSite, writeSiteLog } from "./events";
import { SiteConflictError, SiteRuleError } from "./errors";

/**
 * The Live Feed part of site settings (plan 3d task 3). See
 * .superpowers/sdd/2026-10-04-phase-3d-website-section/task-3-brief.md.
 */

export interface LiveFeedDefaults {
  manifestUrl: string;
  m3uUrl: string;
}

export interface LiveFeedView {
  enabled: boolean;
  manifestUrl: string;
  m3uUrl: string;
  version: number;
}

export interface SaveLiveFeedInput {
  version: number;
  enabled: boolean;
  manifestUrl: string;
  m3uUrl: string;
}

/** Only `https://` or the empty string — the Live Feed's URLs are never plain `http://`. */
const httpsOrEmpty = (s: string): boolean => s === "" || /^https:\/\/\S+$/i.test(s);

/**
 * A stored empty URL shows the environment default (constraints.md Q1) — the defaults never
 * get written back to the row; they're only what the editor sees when nothing's configured.
 */
export async function getLiveFeed(db: DbOrTx, defaults: LiveFeedDefaults): Promise<LiveFeedView> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, 1));
  if (!row) throw new Error("site_settings has no row — the website migration should have inserted id=1");
  return {
    enabled: row.liveFeedEnabled,
    manifestUrl: row.liveManifestUrl || defaults.manifestUrl,
    m3uUrl: row.liveM3uUrl || defaults.m3uUrl,
    version: row.version,
  };
}

/**
 * Saves the Live Feed's on/off flag and URLs. Turning it on with no M3U URL configured is
 * refused — the environment default (if any) only helps display, it doesn't let the feed go
 * live without an editor having set one. Emits a `home` snapshot either way, since the public
 * value (on/off, and the URLs when on) may have changed.
 */
export async function saveLiveFeed(db: Db, input: SaveLiveFeedInput, actor: Actor, subs: SubscriberConfig[]): Promise<LiveFeedView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for("update");
    if (!row) throw new Error("site_settings has no row — the website migration should have inserted id=1");
    if (row.version !== input.version) throw new SiteConflictError();
    if (!httpsOrEmpty(input.manifestUrl) || !httpsOrEmpty(input.m3uUrl)) {
      throw new SiteRuleError(["Live Feed URLs must be https:// or empty."]);
    }
    if (input.enabled && !input.m3uUrl) {
      throw new SiteRuleError(["Add the M3U playlist URL before turning the Live Feed on."]);
    }

    const [updated] = await tx
      .update(siteSettings)
      .set({ liveFeedEnabled: input.enabled, liveManifestUrl: input.manifestUrl, liveM3uUrl: input.m3uUrl, version: row.version + 1, updatedAt: sql`now()` })
      .where(eq(siteSettings.id, 1))
      .returning();

    const logText = row.liveFeedEnabled !== input.enabled
      ? (input.enabled ? "Turned the Live Feed on" : "Turned the Live Feed off")
      : "Changed the Live Feed URLs";
    await writeSiteLog(tx, actor, "live-feed", logText);
    await emitSite(tx, subs, "home");

    return { enabled: updated!.liveFeedEnabled, manifestUrl: updated!.liveManifestUrl, m3uUrl: updated!.liveM3uUrl, version: updated!.version };
  });
}
