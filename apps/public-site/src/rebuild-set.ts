import type { PostDto } from "./dto";
import { categoryPageId, CATEGORY_KINDS, MONTH, type CategoryKind } from "./site-paths";

/** What a post contributes to list pages: its BC month and its category tokens ("ministries:health"). */
export interface Membership {
  month: string;
  categories: string[];
}

const KEYS_FIELD: Record<CategoryKind, "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys"> = {
  ministries: "ministryKeys",
  sectors: "sectorKeys",
  themes: "themeKeys",
  tags: "tagKeys",
};

/** null when the publish date has no usable month (the post then lists nowhere by month). */
export function membershipOf(post: Pick<PostDto, "publishDate" | "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys">): Membership | null {
  const month = post.publishDate.slice(0, 7);
  if (!MONTH.test(month)) return null;
  const categories = new Set<string>();
  for (const kind of CATEGORY_KINDS) {
    for (const key of post[KEYS_FIELD[kind]] ?? []) {
      const id = categoryPageId(kind, key);
      if (id) categories.add(id.slice("category:".length));
    }
  }
  return { month, categories: [...categories].sort() };
}

/**
 * spec §6.2's first row: the pages a post change rebuilds besides the post page itself. The
 * union of before (the index row) and after (the News API's post), so a post that leaves a
 * ministry or a month is taken off the old pages too. Sorted, no duplicates.
 */
export function dependentPages(before: Membership | null, after: Membership | null): string[] {
  if (!before && !after) return [];
  const ids = new Set<string>(["home", "archive", "sitemap"]);
  for (const m of [before, after]) {
    if (!m) continue;
    ids.add(`archive:${m.month}`);
    ids.add(`sitemap:${m.month}`);
    for (const c of m.categories) ids.add(`category:${c}`);
  }
  return [...ids].sort();
}
