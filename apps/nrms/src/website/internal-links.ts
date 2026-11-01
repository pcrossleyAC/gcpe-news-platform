import { asc, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { SECTION_KEYS, internalAddressesIn, type SectionKey } from "@gcpe/site-settings";
import { carousels, emergencyPins, siteSettings, siteSettingsRevisions, websiteResourceLinks, websiteSlides } from "../db/schema";

/**
 * Suite fix W2 (E-review M4, owner approved 2026-10-31): the Hub address check. Every address
 * stored in what the public site shows (the live and next carousels, the emergency pins, the Live
 * Feed, the resource links and the published site settings) whose host is one of the Hub's
 * internal names: it works for staff and is broken for the public. Read-only: nothing is rewritten,
 * the Website editor fixes each one on its screen. Past carousels and unpublished drafts aren't on
 * the site, so they aren't listed.
 */

export type InternalLinkScreen = "carousel" | "pins" | "live-feed" | "links" | "settings";

export interface InternalLink {
  /** The Hub screen where it is edited; for "settings", `section` names the settings screen. */
  screen: InternalLinkScreen;
  section?: SectionKey;
  /** Where on that screen, in the screen's own field names ("" when the screen is enough). */
  where: string;
  /** The address as stored. */
  address: string;
}

const SLOT_LABEL = { primary: "Primary", secondary: "Secondary" } as const;

export async function findInternalLinks(db: DbOrTx, hosts: readonly string[]): Promise<InternalLink[]> {
  if (hosts.length === 0) return [];
  const found: InternalLink[] = [];
  const check = (screen: InternalLinkScreen, where: string, ...texts: string[]) => {
    for (const text of texts) for (const address of internalAddressesIn(text, hosts)) found.push({ screen, where, address });
  };

  const slides = await db
    .select({ state: carousels.state, sortIndex: websiteSlides.sortIndex, headline: websiteSlides.headline, summary: websiteSlides.summary, actionUrl: websiteSlides.actionUrl, facebookPostUrl: websiteSlides.facebookPostUrl })
    .from(websiteSlides)
    .innerJoin(carousels, eq(websiteSlides.carouselId, carousels.id))
    .where(inArray(carousels.state, ["live", "next"]))
    .orderBy(asc(carousels.state), asc(websiteSlides.sortIndex)); // "live" before "next"
  // Numbered as the Carousel screen numbers them: by position, from 1.
  const position = new Map<string, number>();
  for (const s of slides) {
    const n = (position.get(s.state) ?? 0) + 1;
    position.set(s.state, n);
    const prefix = `${s.state === "live" ? "Live" : "Next"} carousel, slide ${n}`;
    check("carousel", `${prefix}: headline`, s.headline);
    check("carousel", `${prefix}: summary`, s.summary);
    check("carousel", `${prefix}: action URL`, s.actionUrl);
    check("carousel", `${prefix}: Facebook post URL`, s.facebookPostUrl);
  }

  const pins = await db.select().from(emergencyPins);
  for (const slot of ["primary", "secondary"] as const) {
    const pin = pins.find((p) => p.slot === slot);
    if (!pin) continue;
    const prefix = `${SLOT_LABEL[slot]} emergency pin`;
    check("pins", `${prefix}: headline`, pin.headline);
    check("pins", `${prefix}: summary`, pin.summary);
    check("pins", `${prefix}: action URL`, pin.actionUrl);
    check("pins", `${prefix}: Facebook post URL`, pin.facebookPostUrl);
  }

  const [feed] = await db.select({ manifest: siteSettings.liveManifestUrl, m3u: siteSettings.liveM3uUrl }).from(siteSettings).where(eq(siteSettings.id, 1));
  if (feed) {
    check("live-feed", "Manifest URL", feed.manifest);
    check("live-feed", "M3U URL", feed.m3u);
  }

  const links = await db.select().from(websiteResourceLinks).orderBy(asc(websiteResourceLinks.sortIndex));
  links.forEach((l, i) => {
    check("links", `Link ${i + 1} text`, l.text);
    check("links", `Link ${i + 1} URL`, l.url);
  });

  const [live] = await db.select({ document: siteSettingsRevisions.document }).from(siteSettingsRevisions).orderBy(desc(siteSettingsRevisions.revision)).limit(1);
  if (live) {
    const doc = live.document as unknown as Record<string, unknown>;
    for (const section of SECTION_KEYS) {
      walk(doc[section], null, (text, linkText) => {
        for (const address of internalAddressesIn(text, hosts)) found.push({ screen: "settings", section, where: linkText ? `Link “${linkText}”` : "", address });
      });
    }
  }
  return found;
}

/** Every string under `value`, with the `text` of the object holding it when that object is a link (has text and url). */
function walk(value: unknown, linkText: string | null, visit: (text: string, linkText: string | null) => void): void {
  if (typeof value === "string") return visit(value, linkText);
  if (Array.isArray(value)) return value.forEach((v) => walk(v, null, visit));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const ownText = typeof obj.text === "string" && typeof obj.url === "string" && obj.text.trim() ? obj.text.trim() : null;
    for (const v of Object.values(obj)) walk(v, ownText, visit);
  }
}
