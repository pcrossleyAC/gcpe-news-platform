import { SECTION_KEYS } from "./model";
import type { BannerSettings, LinkSetting, SectionKey, SiteSettings, StoredSiteSettings } from "./model";

/** Banner visibility at instant `now`: enabled and inside the (optional) schedule window. */
export function bannerVisibleAt(b: BannerSettings, now: Date): boolean {
  const t = now.getTime();
  return b.enabled && (b.startsAt === null || t >= Date.parse(b.startsAt)) && (b.endsAt === null || t < Date.parse(b.endsAt));
}

/** Featured links as stored, then accounts sorted by text (locale compare, case-insensitive). */
export function connectDisplayOrder(n: { featured: LinkSetting[]; accounts: LinkSetting[] }): LinkSetting[] {
  const accounts = [...n.accounts].sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "accent" }));
  return [...n.featured, ...accounts];
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The sections whose JSON differs between two documents, in section order. Stored documents are
 * compared as they are (a part one lacks differs from any value); fill both first
 * (`fillMissingFields`) to compare them as the site shows them. */
export function differingSections(a: StoredSiteSettings, b: StoredSiteSettings): SectionKey[] {
  return SECTION_KEYS.filter((k) => canonical(a[k]) !== canonical(b[k]));
}

/** A new document with one section replaced; the input is not mutated. */
export function withSection<K extends SectionKey>(doc: SiteSettings, key: K, value: SiteSettings[K]): SiteSettings {
  return { ...doc, [key]: value };
}
