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
