import type { CalendarRules } from "./rules";

/** What the editor reads from the rules in the browser: checkActivity, inferLookAhead, the offered lists and the Release fieldset. */
export const EDITOR_RULE_KEYS = [
  "timeZone", "releaseCategoryIds", "required", "awarenessCategoryIds", "consultationsMinistryAbbreviation", "issueExemptCategoryNames",
  "eventsCategoryNames", "unconfirmedIssueCommMaterialId", "hqPlaceholderCategoryName", "contactMinistryExcludedAbbreviations",
  "sharedWithExcludedAbbreviations", "releaseHiddenCategoryNames", "otherCityId", "translationsDefault",
] as const satisfies readonly (keyof CalendarRules)[];
export type EditorRules = Pick<CalendarRules, (typeof EDITOR_RULE_KEYS)[number]>;

export function editorRulesOf(rules: CalendarRules): EditorRules {
  return Object.fromEntries(EDITOR_RULE_KEYS.map((k) => [k, rules[k]])) as EditorRules;
}

/** Legacy hid the Release fieldset, and cleared the release time, for these categories (Scripts/activityhelper.ts:170-196). */
export function releaseFieldsetHidden(categoryName: string | null, rules: Pick<CalendarRules, "releaseHiddenCategoryNames">): boolean {
  return categoryName !== null && rules.releaseHiddenCategoryNames.includes(categoryName);
}

export interface EditorOption {
  id: number;
  name: string;
  isActive: boolean;
}
export interface EditorTerm {
  key: string;
  name: string;
  isActive: boolean;
}
export interface EditorMinistry {
  key: string;
  abbreviation: string | null;
  name: string;
  isActive: boolean;
}
/** Inactive when the contact row or its person is: such a contact stays only on activities that already have it. */
export interface EditorCommContact {
  id: number;
  ministryKey: string;
  name: string;
  rank: number | null;
  isActive: boolean;
}
/** Every choice the editor offers (spec addendum §8.2), inactive rows included and flagged. */
export interface EditorOptions {
  categories: EditorOption[];
  cities: EditorOption[];
  commMaterials: EditorOption[];
  eventPlanners: EditorOption[];
  representatives: EditorOption[];
  initiatives: (EditorOption & { shortName: string | null })[];
  keywords: EditorOption[];
  distributions: EditorOption[];
  origins: EditorOption[];
  premierRequested: EditorOption[];
  videographers: EditorOption[];
  ministries: EditorMinistry[];
  commContacts: EditorCommContact[];
  sectors: EditorTerm[];
  themes: EditorTerm[];
  tags: EditorTerm[];
}

/** 25 MB per file (C153), counted as NRMS counts its uploads. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 50;
/** The extensions the server accepts (packages/storage's ATTACHMENT_TYPES; a test keeps the two equal). */
export const ATTACHMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "msg", "rtf", "txt", "csv"] as const;
/** The file picker's accept attribute. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",");
