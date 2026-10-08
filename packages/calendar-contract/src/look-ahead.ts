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

const plusDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Legacy's InferLASection (Activity.aspx:2466-2521), in its order. */
export function inferLookAhead(i: LookAheadInput, rules: Rules): LookAheadInference {
  if (i.categoryIds.some((c) => rules.awarenessCategoryIds.includes(c))) return { kind: "awareness" };
  if (i.contactMinistryAbbreviation === rules.consultationsMinistryAbbreviation) return { kind: "consultations" };
  // Ticking "Not for Look Ahead" never unassigns a section the activity already has (Activity.aspx:2488-2489).
  if (i.isConfidential) return { kind: "section", section: i.currentSection ?? "not_on_la" };
  const named = (list: readonly string[]) => i.categoryNames.some((n) => list.includes(n));
  if (i.isIssue && !named(rules.issueExemptCategoryNames)) return { kind: "section", section: "issues_and_reports" };
  if (!i.isConfirmed && i.commMaterialIds.includes(rules.unconfirmedIssueCommMaterialId)) return { kind: "section", section: "issues_and_reports" };
  const endsWithinTwoDays = i.startDate !== null && i.endDate !== null && i.endDate < plusDays(i.startDate, 2);
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
 * The section the server stores (spec addendum §7.6). For everyone without the fieldset it is
 * re-inferred on every save, as legacy's hidden fieldset was, except that a stored section the
 * stored fields don't infer is an HQ override, which the page never re-inferred (Activity.aspx:2544-2546).
 */
export function sectionToStore(c: SectionChoice, rules: Rules): HqSection {
  if (c.chosen !== undefined) return c.chosen;
  const stored = c.before?.currentSection ?? null;
  if (c.before && stored !== null) {
    const was = inferLookAhead(c.before, rules);
    if (was.kind === "section" && was.section !== stored) return stored;
  }
  const now = inferLookAhead(c.after, rules);
  return now.kind === "section" ? now.section : (stored ?? "not_on_la");
}
