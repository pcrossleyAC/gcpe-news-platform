import type { OrgRecord, ReleaseRecord, SiteContentChanged, TermRecord } from "@gcpe/events";
import type { LiveFixture } from "./fixtures";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface FixtureEvent {
  source: "core" | "nrms";
  type: string;
  aggregateId: string;
  data: unknown;
}

const asList = (fx: LiveFixture | undefined): Json[] => (Array.isArray(fx?.body) ? (fx!.body as Json[]) : fx?.body ? [fx.body as Json] : []);
const isPost = (v: unknown): v is Json => !!v && typeof v === "object" && "atomId" in (v as object) && "documents" in (v as object);

/**
 * Recovers the minister's address from the live API's `emailHtml` anchor. The href may use
 * double or single quotes (and the live data has a space after "mailto:"); anything without
 * a mailto link yields null rather than echoing the HTML back as if it were an address.
 * "" stays "" (the live API's "no email" value).
 */
export function emailFromHtml(html: string | null): string | null {
  if (html === null) return null;
  if (html === "") return "";
  return /mailto:\s*([^"'?\s>]+)/i.exec(html)?.[1] ?? null;
}

/** Epoch fallback so an empty resource-links fixture still yields a deterministic event. */
const NO_TIMESTAMP = "1970-01-01T00:00:00Z";

function social(c: Json) {
  return { twitterUsername: c.twitterFeedUsername, flickrUrl: c.flickrUri, youtubeUrl: c.youtubeUri, audioUrl: c.audioUri };
}

export function postToRelease(p: Json): ReleaseRecord {
  return {
    key: p.key, kind: p.kind, reference: p.reference, atomId: p.atomId, publishDate: p.publishDate, leadMinistryKey: p.leadMinistryKey,
    summary: p.summary, socialMediaSummary: p.socialMediaSummary, socialMediaHeadline: p.socialMediaHeadline, keywords: p.keywords,
    location: p.location, hasMediaAssets: p.hasMediaAssets, hasTranslations: p.hasTranslations, isNewsOnDemand: p.isNewsOnDemand,
    assetUrl: p.assetUrl, redirectUri: p.redirectUri, documents: p.documents, ministryKeys: p.ministryKeys, sectorKeys: p.sectorKeys,
    tagKeys: p.tagKeys, themeKeys: p.themeKeys, assets: p.azureAssets, translations: p.azureTranslations,
    publishFlags: { toWeb: true, toSubscribers: p.isNewsOnDemand, toMediaLists: false }, mediaListKeys: [], renditions: null,
    timestamp: p.timestamp, mediaText: null,
  };
}

export function buildFixtureEvents(fx: Record<string, LiveFixture>): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  const minister = fx["minister-health"]?.body as Json | undefined;

  asList(fx["ministries"]).forEach((m, i) => {
    const mi = m.key === "health" ? minister : undefined;
    const org: OrgRecord = {
      key: m.key, displayName: m.name, abbreviation: null, sortOrder: i, isActive: m.isActive, parentKey: m.parentMinistryKey,
      url: m.ministryUrl, displayAdditionalName: m.displayAdditionalName,
      minister: {
        name: m.ministerName, summary: mi?.summary ?? null, detailsHtml: mi?.details ?? null, email: mi ? emailFromHtml(mi.emailHtml) : null,
        photoUrl: mi?.photo ?? null, address: mi?.post ?? null,
      },
      contact: m.contactUser, secondContact: m.secondContactUser, weekendContactNumber: m.weekendContactNumber, social: social(m),
      topicLinks: m.topicLinks.map((l: Json) => ({ text: l.key, url: l.uri })), serviceLinks: m.serviceLinks.map((l: Json) => ({ text: l.key, url: l.uri })),
      sectorKeys: [], updatedAt: m.timestamp,
    };
    events.push({ source: "core", type: "org.upserted", aggregateId: `org:${m.key}`, data: org });
    if (m.topPostKey || m.featurePostKey) {
      events.push({ source: "nrms", type: "site.content.changed", aggregateId: `site:feature:ministries:${m.key}`, data: { entity: "categoryFeatures", kind: "ministries", key: m.key, topPostKey: m.topPostKey, featurePostKey: m.featurePostKey } satisfies SiteContentChanged });
    }
  });

  for (const [listName, termKind, categoryKind] of [["sectors", "sector", "sectors"], ["themes", "theme", "themes"], ["tags", "tag", "tags"]] as const) {
    asList(fx[listName]).forEach((c, i) => {
      const term: TermRecord = { kind: termKind, key: c.key, displayName: c.name, sortOrder: i, isActive: c.isActive, social: social(c), updatedAt: c.timestamp };
      events.push({ source: "core", type: `${termKind}.upserted`, aggregateId: `${termKind}:${c.key}`, data: term });
      if (c.topPostKey || c.featurePostKey) {
        events.push({ source: "nrms", type: "site.content.changed", aggregateId: `site:feature:${categoryKind}:${c.key}`, data: { entity: "categoryFeatures", kind: categoryKind, key: c.key, topPostKey: c.topPostKey, featurePostKey: c.featurePostKey } });
      }
    });
  }

  const seen = new Set<string>();
  for (const f of Object.values(fx)) {
    for (const p of asList(f).filter(isPost)) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      events.push({ source: "nrms", type: "release.published", aggregateId: `release:${p.key}`, data: postToRelease(p) });
    }
  }

  const h = fx["home"]?.body as Json | undefined;
  if (h) {
    events.push({ source: "nrms", type: "site.content.changed", aggregateId: "site:home", data: { entity: "home", topPostKey: h.topPostKey, featurePostKey: h.featurePostKey, liveWebcastFlashMediaManifestUrl: h.liveWebcastFlashMediaManifestUrl, liveWebcastM3uPlaylist: h.liveWebcastM3uPlaylist, granville: h.granville, timestamp: h.timestamp } });
  }
  events.push({
    source: "nrms", type: "site.content.changed", aggregateId: "site:slides",
    data: { entity: "slides", slides: asList(fx["slides"]).map((s, i) => ({ id: s.key, sortIndex: i, headline: s.headline, summary: s.summary, actionLabel: s.actionLabel, actionUri: s.actionUri, imageBase64: s.image, imageType: s.imageType, facebookPostUri: s.facebookPostUri, justify: s.justify, timestamp: s.timestamp })) },
  });
  events.push({
    source: "nrms", type: "site.content.changed", aggregateId: "site:resourceLinks",
    data: {
      entity: "resourceLinks",
      links: asList(fx["resource-links"]).map((l, i) => ({ sortIndex: i, text: l.key, uri: l.uri })),
      // The recorded list's own timestamp (not "now"), so the same fixtures always build the
      // same events. The store keeps one timestamp per list; the first link's stands in.
      timestamp: (asList(fx["resource-links"])[0]?.timestamp as string | undefined) ?? NO_TIMESTAMP,
    },
  });
  return events;
}
