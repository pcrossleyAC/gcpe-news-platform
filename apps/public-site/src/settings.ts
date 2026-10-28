import { createHash } from "node:crypto";
import type { SiteTheme } from "@gcpe/config";
import { safeErrorLabel } from "@gcpe/http-kit";
import { defaultSiteSettings, isSafeUrl, type SiteSettings } from "@gcpe/site-settings";
import type { NewsApiClient } from "./news-api-client";
import { basePath, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";
import { DEFAULT_THEME } from "./theme-css";

/** When no tenant config sets one (SiteInfo.timeZone). */
export const DEFAULT_TIME_ZONE = "America/Vancouver";

const derived = new WeakMap<SiteTheme, SiteSettings>();

/**
 * The settings derived from a tenant theme (`defaultSiteSettings`), for a render or sync that
 * wasn't given any (tests, the CLI). A theme whose footer links don't validate as settings (an
 * `http:` link) falls back to the neutral defaults rather than failing a render.
 */
export function themeDefaults(theme: SiteTheme = DEFAULT_THEME): SiteSettings {
  let doc = derived.get(theme);
  if (!doc) {
    try {
      doc = defaultSiteSettings(theme);
    } catch {
      doc = defaultSiteSettings({ colors: DEFAULT_THEME.colors, footerLinks: [] });
    }
    derived.set(theme, doc);
  }
  return doc;
}

/** An editor-entered URL as an href: an absolute https URL as is, a "/" path on this site with
 * the public site's base path in front; anything else (javascript:, http:, `//host`) null. */
export function settingsHref(url: string, site: Pick<SiteInfo, "baseUrl">): string | null {
  if (!isSafeUrl(url)) return null;
  return url.startsWith("/") ? `${basePath(site)}${url}` : url;
}

/** The calendar year at `now` in the tenant's time zone (the footer's "© {year}"). */
export function yearIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(now);
}

/** What `assets/site-banner.json` holds — the inline banner script's input (banner-script.ts). */
export function bannerJson(settings: SiteSettings): string {
  const b = settings.banner;
  return JSON.stringify({ visible: b.enabled, style: b.style, message: b.message, links: b.links, dismissible: b.dismissible, startsAt: b.startsAt, endsAt: b.endsAt });
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The settings' part of the site-state marker (rebuild.ts): one hash per way a section reaches
 * the site. The footer's includes the copyright year, so the year rolls over each January. */
export function settingsHashes(settings: SiteSettings, timeZone: string, now: Date) {
  return {
    footerHash: hash([settings.footer, yearIn(timeZone, now)]),
    themeHash: hash(settings.theme),
    bannerHash: hash(settings.banner),
    connectHash: hash(settings.connect),
    ministryPagesHash: hash(settings.ministryPages),
  };
}

/** The last settings fetched, per output folder (one `SiteStorage` per process, like
 * `enqueueSiteWrite`'s queue) — what a failed fetch keeps using. */
const lastApplied = new WeakMap<SiteStorage, SiteSettings>();

/**
 * This turn's settings (spec "Delivery"): the published document; a 404 (nothing published yet)
 * ⇒ the tenant defaults; a failed or malformed fetch ⇒ the last applied settings, logged, never
 * the defaults — except before any fetch has succeeded in this process, when the defaults are
 * all there is (also logged) rather than failing the turn.
 */
export async function currentSettings(deps: { newsApi: NewsApiClient; storage: SiteStorage; defaults: SiteSettings }): Promise<SiteSettings> {
  try {
    const published = await deps.newsApi.siteSettings();
    const settings = published?.document ?? deps.defaults;
    lastApplied.set(deps.storage, settings);
    return settings;
  } catch (err) {
    const kept = lastApplied.get(deps.storage);
    if (kept) {
      console.error(`[public-site] site settings unavailable; keeping the last applied settings ${safeErrorLabel(err)}`);
      return kept;
    }
    console.error(`[public-site] site settings unavailable and none fetched yet; using the tenant defaults ${safeErrorLabel(err)}`);
    return deps.defaults;
  }
}
