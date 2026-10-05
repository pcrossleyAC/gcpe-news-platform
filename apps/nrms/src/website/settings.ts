import { eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { isGranvilleOn } from "@gcpe/legacy-import";
import { siteSettings } from "../db/schema";
import { formatBcDateTime } from "../releases/workflow";
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

/**
 * Project Blue Bridge (plan 3d task 4): the `granville` mourning-banner switch. Core.Admin
 * only, a typed confirmation phrase, and an email to every admin — see constraints.md.
 */

const CONFIRMATION_PHRASE = "KING CHARLES III";

// This column only ever receives "true"/null from {@link setBlueBridge} below, but read it
// with the same rule the public site and both legacy importers use — @gcpe/legacy-import's
// `isGranvilleOn` — rather than a private copy here that would drift if that ever changes.

export interface BlueBridgeView {
  on: boolean;
  version: number;
  updatedAt: string | null;
}

export async function getBlueBridge(db: DbOrTx): Promise<BlueBridgeView> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, 1));
  if (!row) throw new Error("site_settings has no row — the website migration should have inserted id=1");
  return { on: isGranvilleOn(row.granville), version: row.version, updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null };
}

export interface SetBlueBridgeInput {
  version: number;
  on: boolean;
  confirmation: string;
  acknowledgeIgrs: boolean;
}

export interface SetBlueBridgeDeps {
  subscribers: SubscriberConfig[];
  timeZone: string;
  /** Named in the notify subject ("...turned ON on <site URL>"). */
  siteUrl: string;
  /** Called once, after commit. A failure is logged (without addresses) and never undoes the change. */
  notify: (subject: string, text: string) => Promise<void>;
}

/**
 * Switches `granville` on or off. The confirmation phrase and the IGRS acknowledgement are
 * required both ways (turning it on *and* off) and checked before any write — a wrong/lower-case
 * phrase or a missing acknowledgement leaves the row, the event log and the outbox untouched.
 */
export async function setBlueBridge(db: Db, input: SetBlueBridgeInput, actor: Actor, deps: SetBlueBridgeDeps): Promise<BlueBridgeView> {
  if (input.confirmation.trim() !== CONFIRMATION_PHRASE) throw new SiteRuleError([`Type ${CONFIRMATION_PHRASE} to confirm.`]);
  if (input.acknowledgeIgrs !== true) throw new SiteRuleError(["Confirm that IGRS has approved this change."]);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for("update");
    if (!row) throw new Error("site_settings has no row — the website migration should have inserted id=1");
    if (row.version !== input.version) throw new SiteConflictError();

    const [next] = await tx
      .update(siteSettings)
      .set({ granville: input.on ? "true" : null, version: row.version + 1, updatedAt: sql`now()` })
      .where(eq(siteSettings.id, 1))
      .returning();

    await writeSiteLog(tx, actor, "blue-bridge", input.on ? "Turned Project Blue Bridge ON" : "Turned Project Blue Bridge OFF");
    await emitSite(tx, deps.subscribers, "home");

    return next!;
  });

  const subject = `Project Blue Bridge turned ${input.on ? "ON" : "OFF"} on ${deps.siteUrl}`;
  const text = `${actor.name} turned Project Blue Bridge ${input.on ? "ON" : "OFF"} at ${formatBcDateTime(updated.updatedAt, deps.timeZone)}.`;
  // Fix round 1 (Minor 1): fire-and-forget, after commit — the change is already durable, and
  // an editor's request must never wait on (or fail because of) a slow or down Core/Distribution.
  // Still never addresses — only our own clients' error messages (status codes) reach here.
  void deps.notify(subject, text).catch((e: unknown) => {
    console.error(`[nrms] blue bridge notify failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  return { on: isGranvilleOn(updated.granville), version: updated.version, updatedAt: updated.updatedAt.toISOString() };
}
