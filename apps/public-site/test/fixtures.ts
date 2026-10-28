import { readFileSync } from "node:fs";
import type { SiteSettings } from "@gcpe/site-settings";
import type { CategoryDto, MinistryDto, PostDto, ResourceLinkDto, SlideDto } from "../src/dto";
import type { SiteInfo } from "../src/render";
import { DEFAULT_THEME } from "../src/theme-css";

export const site: SiteInfo = { name: "BC Gov News", baseUrl: "https://news.example", theme: DEFAULT_THEME };

/** A release post with English and French documents, a lead ministry, a tag, one image asset,
 * one non-image asset and one translation — the shape most page tests need by default. */
export function post(over: Partial<PostDto> = {}): PostDto {
  return {
    key: "2026HLTH0001-000001",
    kind: "releases",
    publishDate: "2026-10-03T10:00:00-07:00",
    summary: "Clinics are opening across the province this month.",
    location: "VICTORIA",
    ministryKeys: ["health"],
    tagKeys: ["covid-19"],
    documents: [
      { languageId: 3084, headline: "Cliniques à ouvrir dans la province", subheadline: null, detailsHtml: "<p>Des cliniques ouvriront.</p>", contacts: [] },
      {
        languageId: 4105,
        headline: "Clinics to open across the province",
        subheadline: "Ministry of Health",
        detailsHtml: "<p>Clinics will open.</p>",
        contacts: [{ title: "Media", details: "Alex Example\n250-555-0100" }],
      },
    ],
    azureAssets: [
      { key: "https://files.example/files/a.png", label: "Clinic <photo>", length: 1234 },
      { key: "https://files.example/files/doc.pdf", label: "Backgrounder", length: 1229 },
    ],
    azureTranslations: [{ key: "https://files.example/files/fr.pdf", label: "Français", length: 999 }],
    ...over,
  };
}

export function ministry(over: Partial<MinistryDto> = {}): MinistryDto {
  return {
    key: "health",
    name: "Health",
    isActive: true,
    ministerName: "Minister Alex Example",
    ministryUrl: "https://gov.example/health",
    contactUser: null,
    secondContactUser: null,
    weekendContactNumber: null,
    topicLinks: [],
    serviceLinks: [],
    flickrUri: null,
    youtubeUri: null,
    topPostKey: null,
    featurePostKey: null,
    ...over,
  };
}

export function category(over: Partial<CategoryDto> = {}): CategoryDto {
  return {
    key: "economy",
    kind: "sectors",
    name: "Economy",
    isActive: true,
    topPostKey: null,
    featurePostKey: null,
    ...over,
  };
}

export function slide(over: Partial<SlideDto> = {}): SlideDto {
  return {
    key: "slide-1",
    headline: "Clinics opening across the province",
    summary: "New clinics are opening this month.",
    actionUri: null,
    actionLabel: null,
    emergency: false,
    imageUrl: null,
    sortIndex: 0,
    ...over,
  };
}

export function link(over: Partial<ResourceLinkDto> = {}): ResourceLinkDto {
  return {
    uri: "https://gov.example/resource",
    key: "Resource guide",
    ...over,
  };
}

/** The bc tenant's site settings file (config/tenants/bc.site-settings.json): a full, valid document. */
export function bcSettings(): SiteSettings {
  return JSON.parse(readFileSync(new URL("../../../config/tenants/bc.site-settings.json", import.meta.url), "utf8")) as SiteSettings;
}
