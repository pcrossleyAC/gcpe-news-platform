import type { PostDto } from "./dto";
import { categoryPageId, CATEGORY_KINDS, isListingKind, MONTH, type CategoryKind } from "./site-paths";

/** What a post contributes to list pages: its BC month and day and its category tokens ("ministries:health"). */
export interface Membership {
  month: string;
  /** The BC calendar day (`YYYY-MM-DD`), which decides the post's government term. */
  day: string;
  categories: string[];
  /** The post kind; a listing kind (`releases`, …) also puts the post on that kind's listing page. */
  kind?: string;
}

/** The term a BC day falls in (the latest start on or before it), or null before every term. */
export type TermOf = (day: string) => { slug: string; isCurrent: boolean } | null;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const KEYS_FIELD: Record<CategoryKind, "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys"> = {
  ministries: "ministryKeys",
  sectors: "sectorKeys",
  themes: "themeKeys",
  tags: "tagKeys",
};

/** null when the publish date has no usable month (the post then lists nowhere by month). */
export function membershipOf(post: Pick<PostDto, "publishDate" | "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys"> & { kind?: string }): Membership | null {
  const month = post.publishDate.slice(0, 7);
  const day = post.publishDate.slice(0, 10);
  if (!MONTH.test(month) || !DAY.test(day)) return null;
  const categories = new Set<string>();
  for (const kind of CATEGORY_KINDS) {
    for (const key of post[KEYS_FIELD[kind]] ?? []) {
      const id = categoryPageId(kind, key);
      if (id) categories.add(id.slice("category:".length));
    }
  }
  return { month, day, categories: [...categories].sort(), ...(post.kind ? { kind: post.kind } : {}) };
}

/**
 * spec §6.2's first row: the pages a post change rebuilds besides the post page itself. The
 * union of before (the index row) and after (the News API's post), so a post that leaves a
 * ministry or a month is taken off the old pages too. Sorted, no duplicates.
 *
 * With `termOf` (new-government spec §3): also the terms index, the page of the term each day
 * falls in, and the `current` alias when that term is the current one.
 */
export function dependentPages(before: Membership | null, after: Membership | null, termOf?: TermOf): string[] {
  if (!before && !after) return [];
  const ids = new Set<string>(["home", "archive", "sitemap", "kind-feeds"]);
  for (const m of [before, after]) {
    if (!m) continue;
    ids.add(`archive:${m.month}`);
    ids.add(`sitemap:${m.month}`);
    if (m.kind && isListingKind(m.kind)) ids.add(`kind:${m.kind}`);
    for (const c of m.categories) {
      ids.add(`category:${c}`);
      // The category indexes list each category's latest posts (M8, M16).
      const kind = c.slice(0, c.indexOf(":"));
      ids.add(kind === "ministries" ? "ministries" : `index:${kind}`);
    }
    if (!termOf) continue;
    ids.add("archive-terms");
    const term = termOf(m.day);
    if (term) {
      ids.add(`archive-term:${term.slug}`);
      if (term.isCurrent) ids.add("archive-term:current");
    }
  }
  return [...ids].sort();
}
