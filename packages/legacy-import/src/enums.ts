export const RELEASE_TYPE_TO_KIND = Object.freeze({
  1: "releases",
  2: "stories",
  3: "factsheets",
  4: "updates",
  5: "advisories",
} as const);

export function releaseKindFromLegacy(type: number): string {
  const kind = (RELEASE_TYPE_TO_KIND as Record<number, string>)[type];
  if (!kind) throw new Error(`Unknown legacy ReleaseType ${type}`);
  return kind;
}

export const LANGUAGE_BY_LCID = Object.freeze({ 4105: "en", 3084: "fr" } as const) as Readonly<Record<number, "en" | "fr">>;

export const PUBLISH_OPTIONS = { NewsArchives: 1, NewsOnDemand: 2, MediaContacts: 4 } as const;

export function hasPublishOption(value: number, flag: number): boolean {
  return (value & flag) === flag;
}
