import { sameCategoryName } from "./category-name";
import type { HqSection } from "./enums";
import type { CalendarRules } from "./rules";

export interface LookAheadInput {
  categoryIds: readonly number[];
  categoryNames: readonly string[];
  contactMinistryAbbreviation: string | null;
  isConfidential: boolean;
  isIssue: boolean;
  isConfirmed: boolean;
  commMaterialIds: readonly number[];
  /** BC dates. */
  startDate: string | null;
  endDate: string | null;
  /** The section the activity has now; null for a new one. */
  currentSection: HqSection | null;
}

export type LookAheadInference = { kind: "awareness" } | { kind: "consultations" } | { kind: "section"; section: HqSection };

type Rules = Pick<CalendarRules, "awarenessCategoryIds" | "consultationsMinistryAbbreviation" | "issueExemptCategoryNames" | "eventsCategoryNames" | "unconfirmedIssueCommMaterialId">;

/** Null for a date JavaScript can't read: the form infers as it is typed, so a five-digit year reaches here before validation refuses it. */
const plusDays = (date: string, n: number): string | null => {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Legacy's InferLASection (Activity.aspx:2466-2521), in its order. */
export function inferLookAhead(i: LookAheadInput, rules: Rules): LookAheadInference {
  if (i.categoryIds.some((c) => rules.awarenessCategoryIds.includes(c))) return { kind: "awareness" };
  if (i.contactMinistryAbbreviation === rules.consultationsMinistryAbbreviation) return { kind: "consultations" };
  // Ticking "Not for Look Ahead" never unassigns a section the activity already has (Activity.aspx:2488-2489).
  if (i.isConfidential) return { kind: "section", section: i.currentSection ?? "not_on_la" };
  const named = (list: readonly string[]) => i.categoryNames.some((n) => list.some((l) => sameCategoryName(l, n)));
  if (i.isIssue && !named(rules.issueExemptCategoryNames)) return { kind: "section", section: "issues_and_reports" };
  if (!i.isConfirmed && i.commMaterialIds.includes(rules.unconfirmedIssueCommMaterialId)) return { kind: "section", section: "issues_and_reports" };
  const twoDaysOn = i.startDate === null ? null : plusDays(i.startDate, 2);
  const endsWithinTwoDays = twoDaysOn !== null && i.endDate !== null && i.endDate < twoDaysOn;
  if (i.isConfirmed || endsWithinTwoDays) return { kind: "section", section: named(rules.eventsCategoryNames) ? "events_and_speeches" : "in_the_news" };
  return { kind: "section", section: "not_on_la" };
}

export interface SectionChoice {
  /** The stored activity's inputs, its stored section as currentSection; null on create. */
  before: LookAheadInput | null;
  /** The saved inputs, with currentSection still the stored section (null on create). */
  after: LookAheadInput;
  /** A Look Ahead fieldset user's own choice, when they sent one. */
  chosen: HqSection | undefined;
}

/**
 * The section the server stores (spec addendum §7.6). Awareness and the consultations ministry fix
 * it: no one overrides it, so it stays what is stored, Not on LA for a new activity (Activity.aspx:2470-2481).
 * Otherwise a Look Ahead fieldset user's choice wins. For everyone else it is re-inferred on every
 * save, as legacy's hidden fieldset was, except that a stored section the stored fields don't infer
 * is an HQ override, which the page never re-inferred (Activity.aspx:2544-2546).
 */
export function sectionToStore(c: SectionChoice, rules: Rules): HqSection {
  const stored = c.before?.currentSection ?? null;
  const now = inferLookAhead(c.after, rules);
  if (now.kind !== "section") return stored ?? "not_on_la";
  if (c.chosen !== undefined) return c.chosen;
  if (c.before && stored !== null) {
    const was = inferLookAhead(c.before, rules);
    if (was.kind === "section" && was.section !== stored) return stored;
  }
  return now.section;
}
