/**
 * Response shapes for `/nrms/api/site/...` (apps/nrms/src/http/site-routes.ts, codemap.md §2).
 * `@gcpe/nrms-contract` is zod-only and carries no Website types (codemap.md §3) — these are
 * plain mirrors of the server's own view types (apps/nrms/src/website/*.ts), kept here as the
 * one place every Website screen imports them from.
 */

export type Justify = "left" | "right";
export type PinSlot = "primary" | "secondary";
export type CarouselState = "live" | "next" | "past";

export interface SlideView {
  id: string;
  headline: string;
  summary: string;
  actionUrl: string;
  facebookPostUrl: string;
  justify: Justify;
  hasImage: boolean;
  imageUrl: string | null;
}

export interface CarouselView {
  id: string;
  state: CarouselState;
  goLiveAt: string | null;
  wentLiveAt: string | null;
  version: number;
  slides: SlideView[];
}

export interface CarouselsResponse {
  live: CarouselView | null;
  next: CarouselView | null;
  past: CarouselView[];
}

export interface PinView {
  slot: PinSlot;
  pinned: boolean;
  version: number;
  slide: SlideView;
}

export interface LiveFeedView {
  enabled: boolean;
  manifestUrl: string;
  m3uUrl: string;
  version: number;
}

export interface BlueBridgeView {
  on: boolean;
  version: number;
  updatedAt: string | null;
  /** Legacy's warning text (ProjectBlueBridge.aspx:50), sent verbatim on every GET. */
  warning: string;
}

export interface ResourceLinkView {
  id: string;
  text: string;
  url: string;
}

export interface LinksView {
  version: number;
  links: ResourceLinkView[];
}

export interface SiteFileView {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size: number;
  createdAt: string;
  createdBy: string;
}

export interface ListFilesResult {
  total: number;
  files: SiteFileView[];
}

export type FeatureKind = "home" | "ministries" | "sectors" | "themes";

export interface FeaturedWhereRow {
  kind: FeatureKind;
  key: string;
  label: string;
  top: { id: string; key: string; headline: string } | null;
  feature: { id: string; key: string; headline: string } | null;
}

export type SiteLogArea = "carousel" | "pins" | "live-feed" | "blue-bridge" | "links" | "files" | "features";

export const SITE_LOG_AREAS: readonly SiteLogArea[] = ["carousel", "pins", "live-feed", "blue-bridge", "links", "files", "features"];

export interface SiteLogEntry {
  at: string;
  actorName: string;
  area: SiteLogArea;
  text: string;
}
