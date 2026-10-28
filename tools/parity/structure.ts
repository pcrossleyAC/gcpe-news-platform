/** Selectors the legacy page carries that our port must also carry (queried on the whole document). */
export const STRUCTURE: Record<string, string[]> = {
  home: [
    ".home-features",
    ".home-body",
    ".top-article .article h2 a",
    ".regular-articles .article .item-date",
    ".news-control",
    ".resource-links",
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
  ministry: [".ministry-listing", ".home-features .resource-links.minister", ".home-body .article", ".collapsible-regions .resource-links"],
  premier: [".ministry-listing", ".home-features .resource-links.minister", ".home-body .article", ".collapsible-regions .resource-links"],
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
