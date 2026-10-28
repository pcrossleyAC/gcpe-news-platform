const MINISTRY_SELECTORS = [
  ".ministry-listing",
  ".home-features .resource-links.minister",
  ".home-body .article",
  ".collapsible-regions .resource-links",
];

/** Selectors the legacy page carries that our port must also carry (queried on the whole document). */
export const STRUCTURE: Record<string, string[]> = {
  home: [
    ".home-features",
    ".home-body",
    ".top-article .article h2 a",
    ".regular-articles .article .item-date",
    ".news-control",
    ".home-features .resource-links.connect",
    "#carousel-holder .home-banner",
  ],
  release: [
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
