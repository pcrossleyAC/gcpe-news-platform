import { createHash } from "node:crypto";
import type { SiteTheme } from "@gcpe/config";
import { isSafeUrl as isSafeAbsoluteUrl, safeErrorLabel } from "@gcpe/http-kit";
import { defaultSiteSettings, fillMissingFields, isSafeUrl, storedSiteSettingsSchema, type SiteSettings, type StoredSiteSettings } from "@gcpe/site-settings";
import type { HomeDto } from "./dto";
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

/** A parsed host of letters, digits, dots and hyphens (punycode included) and an optional port, no
 * userinfo: WHATWG URL hosts may also hold $ ` " ' = ; ( ), which must never reach a page. */
function plainHost(u: string): boolean {
  try {
    const parsed = new URL(u);
    return !parsed.username && !parsed.password && /^[a-z0-9.-]+(:\d+)?$/i.test(parsed.host);
  } catch {
    return false;
  }
}

let warnedLiveUrl = false;

/** The News API home settings' live webcast playlist, only when it is an absolute https URL (the
 * /live/ page plays it); anything else (http:, a path, javascript:) is null with one log per
 * process, and the site shows "off air". Absent or blank: null, silently. */
export function liveStreamUrl(home: Pick<HomeDto, "liveWebcastM3uPlaylist">): string | null {
  const u = home.liveWebcastM3uPlaylist;
  if (typeof u !== "string" || u.trim() === "") return null;
  if (isSafeAbsoluteUrl(u, { relative: false, schemes: ["https:"] }) && plainHost(u)) return u;
  if (!warnedLiveUrl) {
    warnedLiveUrl = true;
    console.error("[public-site] live webcast URL is not https; shown as off air");
  }
  return null;
}

/** What `assets/live.json` holds: the flag only, never the stream URL (site.js polls it). */
export function liveJson(home: Pick<HomeDto, "liveWebcastM3uPlaylist">): string {
  return JSON.stringify({ live: liveStreamUrl(home) !== null });
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The settings' part of the site-state marker (rebuild.ts): one hash per way a section reaches
 * the site. The footer's includes the copyright year, so the year rolls over each January. */
export function settingsHashes(settings: SiteSettings, timeZone: string, now: Date) {
  return {
    footerHash: hash([settings.footer, yearIn(timeZone, now)]),
    // Every page's header and footer column headings (renderHeader, renderFooter): chrome like the footer.
    headerHash: hash([settings.navigation.newsLabel, settings.navigation.liveLabel, settings.navigation.headerLinks, settings.navigation.showHeaderSearch, settings.navigation.footerConnectHeading, settings.navigation.footerMoreInfoHeading]),
    // The page labels and listing titles: aggregate pages only (no post shows them).
    labelsHash: hash([settings.navigation.labels, settings.navigation.listingTitles]),
    themeHash: hash(settings.theme),
    bannerHash: hash(settings.banner),
    connectHash: hash(settings.connect),
    ministryPagesHash: hash(settings.ministryPages),
    // Only /contacts/ shows the Media contacts page settings.
    contactsPageHash: hash(settings.contactsPage),
    // Only /privacy/ shows the privacy text; the 404 page (in "static") and every release (its
    // licence line) show their own parts, so one edit reaches only the pages that show it.
    privacyHash: hash(settings.pageText.privacy),
    liveTextHash: hash(settings.pageText.live),
    notFoundHash: hash(settings.pageText.notFound),
    assetLicenceHash: hash(settings.pageText.assetLicence),
    // Only /search/ shows the older-archive links (its Date filter).
    searchTextHash: hash(settings.pageText.searchArchiveLinks),
    // Only the one account the release page's Share → Instagram links to, so another network's
    // edit (the Connect page's business) doesn't re-render every release.
    releaseShareHash: hash(releaseInstagram(settings) ?? null),
  };
}

/** The Instagram account every release page's Share list links to: BC's featured account, else
 * the first listed (legacy shared to governmentofbc; P2-R5). */
export function releaseInstagram(settings: SiteSettings): { url: string; text: string } | null {
  const ig = settings.connect.instagram.featured[0] ?? settings.connect.instagram.accounts[0];
  return ig ? { url: ig.url, text: ig.text } : null;
}

/** The last applied settings document, beside the site-state marker (rebuild.ts's
 * SITE_STATE_PATH) and, like it, not served: a leading dot (the `/site` mount's `dotfiles:
 * "deny"`), never linked. It survives a restart, which the host does every minute or so. */
export const SITE_SETTINGS_PATH = ".site-settings.json";

/** What this process last wrote to SITE_SETTINGS_PATH, per output folder, so an unchanged
 * document isn't rewritten every turn. */
const persisted = new WeakMap<SiteStorage, string>();

/** The persisted document as stored: one written before a later part existed still parses (the
 * caller fills it). */
async function readPersisted(storage: SiteStorage): Promise<StoredSiteSettings | null> {
  const raw = await storage.read(SITE_SETTINGS_PATH);
  if (raw === null) return null;
  try {
    return storedSiteSettingsSchema.parse(JSON.parse(raw));
  } catch {
    return null; // malformed/foreign content: treated as nothing persisted
  }
}

/**
 * This turn's settings (spec "Delivery"):
 * - fetched: the published document, or the tenant defaults on a 404 (nothing published yet) —
 *   persisted as the last applied;
 * - the fetch failed (an error, a timeout, a malformed or empty answer): the last applied
 *   document from SITE_SETTINGS_PATH (logged). Used exactly like a fetched one — the marker and
 *   the rebuilds follow it, since rebuilding from the last published document is correct (and in
 *   steady state its hashes equal the marker's), and the footer hash still takes this year;
 * - failed with nothing persisted: the tenant defaults (logged) with `fallbackDefaults: true` —
 *   a stand-in for this render only. The caller compares with the marker's own settings hashes
 *   (rebuild.ts's keepSettingsHashes), so the stand-in queues no settings rebuild by itself and
 *   Blue Bridge, test, chrome and base URL changes still rebuild the site; if a rebuild-all is
 *   queued anyway, the marker records the defaults' hashes (every page now shows them) and the
 *   first successful fetch rebuilds back to the published settings (sync.ts's
 *   applyChromeChanges).
 * Unlike that stand-in, the defaults of a 404 (first bullet) are real settings: they set and
 * move the hashes, so a cold start with nothing published writes the marker with them.
 */
export async function currentSettings(deps: { newsApi: NewsApiClient; storage: SiteStorage; defaults: SiteSettings }): Promise<{ settings: SiteSettings; fallbackDefaults: boolean }> {
  let settings: SiteSettings;
  try {
    const published = (await deps.newsApi.siteSettings())?.document;
    settings = published ? fillMissingFields(published, deps.defaults) : deps.defaults;
  } catch (err) {
    const kept = await readPersisted(deps.storage);
    if (kept) {
      console.error(`[public-site] site settings unavailable; keeping the last applied settings ${safeErrorLabel(err)}`);
      return { settings: fillMissingFields(kept, deps.defaults), fallbackDefaults: false };
    }
    console.error(`[public-site] site settings unavailable and none applied yet; using the tenant defaults ${safeErrorLabel(err)}`);
    return { settings: deps.defaults, fallbackDefaults: true };
  }
  const json = JSON.stringify(settings);
  if (persisted.get(deps.storage) !== json) {
    await deps.storage.write(SITE_SETTINGS_PATH, json);
    persisted.set(deps.storage, json);
  }
  return { settings, fallbackDefaults: false };
}
