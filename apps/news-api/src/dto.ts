import type { CategoryRow, FeatureRow, HomeRow, PostRow, ResourceLinkRow, SlideRow } from "./db/schema";
import { formatOffsetDateTime } from "./time";

export function toPostDto(p: PostRow, tz: string) {
  return {
    kind: p.kind,
    atomId: p.atomId,
    summary: p.summary,
    socialMediaSummary: p.socialMediaSummary,
    socialMediaHeadline: p.socialMediaHeadline,
    keywords: p.keywords,
    publishDate: formatOffsetDateTime(p.publishDate, tz),
    leadMinistryKey: p.leadMinistryKey,
    hasMediaAssets: p.hasMediaAssets,
    hasTranslations: p.hasTranslations,
    isNewsOnDemand: p.isNewsOnDemand,
    assetUrl: p.assetUrl,
    location: p.location,
    documents: p.documents,
    reference: p.reference,
    redirectUri: p.redirectUri,
    ministryKeys: p.ministryKeys,
    sectorKeys: p.sectorKeys,
    tagKeys: p.tagKeys,
    themeKeys: p.themeKeys,
    azureAssets: p.assets,
    azureTranslations: p.translations,
    key: p.key,
    timestamp: formatOffsetDateTime(p.timestamp, tz),
  };
}

export function toKeyValue(p: Pick<PostRow, "key" | "kind">): { key: string; value: string } {
  return { key: p.key, value: p.kind };
}

export function toMinistryDto(c: CategoryRow, f: FeatureRow | undefined, childKey: string | null, tz: string) {
  const m = c.ministry!;
  const ts = formatOffsetDateTime(c.timestamp, tz);
  const link = (l: { text: string; url: string }) => ({ uri: l.url, key: l.text, timestamp: ts });
  return {
    childMinistryKey: childKey,
    parentMinistryKey: m.parentKey,
    ministryUrl: m.url,
    displayAdditionalName: m.displayAdditionalName,
    topicLinks: m.topicLinks.map(link),
    serviceLinks: m.serviceLinks.map(link),
    newsletterLinks: [] as never[],
    ministerName: m.minister.name,
    contactUser: m.contact,
    secondContactUser: m.secondContact,
    weekendContactNumber: m.weekendContactNumber,
    twitterFeedUsername: c.social.twitterUsername,
    flickrUri: c.social.flickrUrl,
    youtubeUri: c.social.youtubeUrl,
    audioUri: c.social.audioUrl,
    isActive: c.isActive,
    kind: "ministries",
    name: c.name,
    topPostKey: f?.topPostKey ?? null,
    featurePostKey: f?.featurePostKey ?? null,
    key: c.key,
    timestamp: ts,
  };
}

export function ministerEmailHtml(email: string | null): string | null {
  if (email === null) return null;
  if (email === "") return "";
  return `<a href="mailto: ${email}">${email}</a>`;
}

export function toMinisterDto(c: CategoryRow, tz: string) {
  const m = c.ministry!.minister;
  return {
    headline: m.name,
    summary: m.summary,
    details: m.detailsHtml,
    emailHtml: ministerEmailHtml(m.email),
    photo: m.photoUrl,
    post: m.address,
    key: c.key,
    timestamp: formatOffsetDateTime(c.timestamp, tz),
  };
}

export function toCategoryDto(c: CategoryRow, f: FeatureRow | undefined, tz: string) {
  return {
    twitterFeedUsername: c.social.twitterUsername,
    flickrUri: c.social.flickrUrl,
    youtubeUri: c.social.youtubeUrl,
    audioUri: c.social.audioUrl,
    isActive: c.isActive,
    kind: c.kind,
    name: c.name,
    topPostKey: f?.topPostKey ?? null,
    featurePostKey: f?.featurePostKey ?? null,
    key: c.key,
    timestamp: formatOffsetDateTime(c.timestamp, tz),
  };
}

export function toHomeDto(h: HomeRow | undefined, tz: string) {
  return {
    liveWebcastFlashMediaManifestUrl: h?.liveWebcastFlashMediaManifestUrl ?? null,
    liveWebcastM3uPlaylist: h?.liveWebcastM3uPlaylist ?? null,
    granville: h?.granville ?? null,
    kind: "home",
    name: null,
    topPostKey: h?.topPostKey ?? null,
    featurePostKey: h?.featurePostKey ?? null,
    key: "default",
    timestamp: formatOffsetDateTime(h?.timestamp ?? new Date(0), tz),
  };
}

export function toSlideDto(s: SlideRow, tz: string) {
  return {
    headline: s.headline,
    summary: s.summary,
    actionLabel: s.actionLabel,
    actionUri: s.actionUri,
    image: s.image ? s.image.toString("base64") : null,
    facebookPostUri: s.facebookPostUri,
    justify: s.justify,
    imageType: s.imageType,
    key: s.id,
    timestamp: formatOffsetDateTime(s.timestamp, tz),
  };
}

export function toResourceLinkDto(l: ResourceLinkRow, tz: string) {
  return { uri: l.uri, key: l.text, timestamp: formatOffsetDateTime(l.timestamp, tz) };
}
