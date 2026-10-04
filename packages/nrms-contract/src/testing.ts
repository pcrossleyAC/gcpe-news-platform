import type { ReleaseView } from "./types";

export function view(over: Partial<ReleaseView> = {}): ReleaseView {
  return {
    id: "00000000-0000-4000-8000-000000000001", type: "release", key: null, reference: null, status: "draft", onHold: false, version: 1,
    leadMinistryKey: "health", activityId: null, publishAt: null, releasedAt: null,
    publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: false },
    assetUrl: null, assetAltText: null, hasMediaAssets: false, hasTranslations: false, redirectUrl: null, keywords: null, atomId: null,
    nodSubscribers: null, mediaSubscribers: null, lastError: null, flickrAlert: null,
    languages: [{ languageId: 4105, location: "VICTORIA", summary: "Clinics open.", summaryEdited: false, socialMediaSummary: null }],
    documents: [{ id: "d1", sortIndex: 0, layout: "formal", languages: [{ languageId: 4105, pageTitle: "News Release", headline: "Clinics open", subheadline: null, organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: null, contacts: ["Media Relations\n250-555-0100"] }] }],
    ministries: ["health"], sectors: ["health"], themes: [], tags: [], mediaListKeys: [], files: [], features: [],
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
    ...over,
  };
}
