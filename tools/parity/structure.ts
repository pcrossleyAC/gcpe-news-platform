const MINISTRY_SELECTORS = [
  ".ministry-listing",
  ".home-features .resource-links.minister",
  ".home-body .article",
  ".collapsible-regions .resource-links",
];

const LISTING = [
  ".home-body .other-articles .regular-articles .article h2 a",
  ".regular-articles .article .item-date",
  ".news-control .read-more",
];
const STORY_LISTING = [
  ...LISTING,
  ".home-features .resource-links.connect",
  ".collapsible-regions .resource-links",
  ".news-control .load-more",
];
const GROUPED_LISTING = [
  ".news-listing .home-features .resource-links.connect",
  ".news-listing .home-body .grouped-articles a",
  ".grouped-articles .article",
  ".news-control .load-more",
];

/** Selectors the legacy page carries that our port must also carry (queried on the whole document). */
export const STRUCTURE: Record<string, string[]> = {
  home: [
    'meta[name="description"]',
    ".home-features",
    ".home-body",
    ".top-article .article h2 a",
    ".regular-articles .article .item-date",
    ".news-control",
    ".home-features .resource-links.connect",
    "#carousel-holder .home-banner",
  ],
  release: [
    'meta[name="twitter:site"]',
    ".story-page",
    ".story-features .resource-links.share",
    ".story-features .location-and-date",
    ".story-body .story-copy",
    ".backgrounder",
    "#assets",
    ".media-container .related-articles",
  ],
  ministry: MINISTRY_SELECTORS,
  premier: MINISTRY_SELECTORS,
  sector: [
    ".ministry-listing.sector-listing",
    ".home-features .resource-links.connect",
    ".regular-articles .article",
    ".collapsible-regions .resource-links",
  ],
  search: [
    ".search .search-body",
    ".search-panel.search-filters .search-filter",
    ".search-results .search-panel-bar",
    ".search-results .search-numbers",
    ".search-results .article",
  ],
  subscribe: [".connect.subscribe .home-body", "#noticeOfCollection", ".expandable-section", 'a[href*="/subscribe/manage"]'],
  connect: [
    ".connect .home-body",
    ".expandable-section.facebook",
    ".expandable-section.linkedin",
    ".expandable-section.rss",
    ".home-body > p a",
  ],
  contacts: [
    ".comm-contacts",
    ".comm-contacts .header",
    ".comm-contacts .row .contact-name",
    '.comm-contacts .row a[href^="mailto:"]',
  ],
  live: [".connect .home-body", ".wowza-wrapper.asset.video", ".placeholder-container img"],
  privacy: [".connect .home-body", ".connect .home-body h1", "#body p"],
  factsheets: STORY_LISTING,
  stories: STORY_LISTING,
  archive: LISTING,
  "ministry-factsheets": [
    ".ministry-listing.fact-sheets",
    ".home-features .resource-links.minister",
    ".regular-articles .article",
    ".collapsible-regions .resource-links",
  ],
  ministries: GROUPED_LISTING,
  sectors: GROUPED_LISTING,
  themes: GROUPED_LISTING,
  topics: GROUPED_LISTING,
  biography: [".ministry-listing", ".biography-details", ".minister-bio-picture img", ".news-control .read-more"],
};

export interface StructureRow {
  selector: string;
  /** missing: legacy has it, ours lacks it. legacy-absent: legacy lacks it (content differs), reported only. */
  status: "ok" | "missing" | "legacy-absent";
}

export function structureReport(legacy: Record<string, boolean>, ours: Record<string, boolean>): StructureRow[] {
  return Object.keys(legacy).map((selector) => ({
    selector,
    status: !legacy[selector] ? "legacy-absent" : ours[selector] ? "ok" : "missing",
  }));
}

/** True when any row is `missing` (legacy has the selector, ours lacks it); the run fails on this. */
export function structureFailed(rows: StructureRow[]): boolean {
  return rows.some((r) => r.status === "missing");
}
