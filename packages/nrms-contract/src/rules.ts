import { LANG_EN, LANGUAGE_NAME, type PublishOptions, type ReleaseType, type ReleaseView } from "./types";

export interface TypeRules {
  creatable: boolean;
  mediaListsAllowed: boolean;
  mediaListRequired: boolean;
  /** Sectors, themes, tags, summary, keywords, release date, assets, translations. */
  categoriesBeyondMinistries: boolean;
  assetsAllowed: boolean;
  pageImageAllowed: boolean;
  /** Story/Factsheet keys come from the headline and stay editable until scheduled. */
  keyEditable: boolean;
  /** Release/Advisory/Update get the legacy `{year}{ABBR}{n}-{m}` key at approve. */
  generatesKey: boolean;
  unpublishable: boolean;
  /** Legacy AllowPublishToNewsOnDemand. */
  nodAllowed: boolean;
  /** Media lists lock once a Release or Factsheet has gone live. */
  mediaListsLockAfterRelease: boolean;
  defaultPublishOptions(hasMediaLists: boolean): PublishOptions;
}

export function typeRules(type: ReleaseType): TypeRules {
  const advisory = type === "advisory";
  return {
    creatable: type !== "update",
    mediaListsAllowed: type === "release" || type === "factsheet" || advisory,
    mediaListRequired: advisory,
    categoriesBeyondMinistries: !advisory,
    assetsAllowed: !advisory,
    pageImageAllowed: !advisory,
    keyEditable: type === "story" || type === "factsheet",
    generatesKey: type === "release" || type === "advisory" || type === "update",
    unpublishable: !advisory,
    nodAllowed: type === "release" || type === "story" || type === "factsheet",
    mediaListsLockAfterRelease: type === "release" || type === "factsheet",
    defaultPublishOptions: (hasMediaLists) => ({
      // Legacy NewModel.cs: Advisories are never published to the website.
      toWeb: !advisory,
      toSubscribers: type === "release" || type === "update",
      toMediaLists: hasMediaLists,
    }),
  };
}

const ASSET_HOSTS = [/(^|\.)flickr\.com$/, /^flic\.kr$/, /(^|\.)youtube\.com$/, /^youtu\.be$/];

/** Legacy Release.aspx.cs asset rules. Returns a message, or null when acceptable. */
export function assetUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The asset URL must be an absolute URL.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The asset URL must start with http:// or https://.";
  const host = u.hostname.toLowerCase();
  if (/(^|\.)facebook\.com$/.test(host) || host === "fb.watch") return "Facebook is no longer supported due to privacy concerns. Use YouTube or Flickr URLs instead.";
  if (ASSET_HOSTS.some((re) => re.test(host))) return null;
  if (host === "news.gov.bc.ca" && u.pathname.replace(/\/$/, "") === "/live") return null;
  return "Use a YouTube or Flickr URL, or https://news.gov.bc.ca/live.";
}

export function statusText(v: Pick<ReleaseView, "status" | "type" | "reference" | "publishAt">, nowMs: number): string {
  const advisory = v.type === "advisory";
  switch (v.status) {
    case "draft":
    case "approved":
      return v.publishAt ? "Planned" : v.reference ? "Approved" : "Draft";
    case "scheduled":
      return v.publishAt && Date.parse(v.publishAt) > nowMs ? "Scheduled" : "Publishing...";
    case "publishing":
      return "Republishing...";
    case "published":
      return advisory ? "Sent" : "Published";
    case "unpublishing":
      return advisory ? "Unscheduling..." : "Unpublishing...";
    case "failed":
      return "Failed";
    case "deleted":
      return "Deleted";
  }
}

const isBlankHtml = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;| /g, " ").trim() === "";

export function approveProblems(v: ReleaseView): string[] {
  if (v.type === "advisory") return [];
  if (v.ministries.length === 0) return ["Choose at least one ministry."];
  if (!v.leadMinistryKey && v.ministries.length > 1) return ["Choose the lead ministry."];
  return [];
}

export function publishProblems(v: ReleaseView): string[] {
  const rules = typeRules(v.type);
  const out: string[] = [];
  if (rules.categoriesBeyondMinistries) {
    if (v.ministries.length === 0) out.push("Choose at least one ministry.");
    if (v.sectors.length === 0) out.push("Choose at least one sector.");
  }
  if (rules.mediaListRequired && v.mediaListKeys.length === 0) out.push("Choose at least one media distribution list.");
  if (v.documents.length === 0) out.push("Add at least one document.");
  for (const d of [...v.documents].sort((a, b) => a.sortIndex - b.sortIndex)) {
    for (const l of [...d.languages].sort((a, b) => (a.languageId === LANG_EN ? -1 : b.languageId === LANG_EN ? 1 : 0))) {
      const label = `Document ${d.sortIndex + 1} (${LANGUAGE_NAME[l.languageId]})`;
      if (!l.headline.trim()) out.push(`${label} needs a headline.`);
      if (isBlankHtml(l.bodyHtml)) out.push(`${label} needs body text.`);
      if (d.layout === "formal" && rules.categoriesBeyondMinistries && !l.organizations?.trim()) out.push(`${label} needs organizations (formal layout).`);
    }
  }
  return out;
}
