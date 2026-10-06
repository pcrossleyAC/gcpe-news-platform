/**
 * `GET /nrms/api/categories`'s shape (fix round 1, minor: one shared definition — this used to
 * be duplicated, byte-for-byte, between NewReleaseScreen.tsx and CategoriesSection.tsx).
 * apps/staff-web/src/screens/search/SearchScreen.tsx keeps its own smaller local type
 * (ministries/sectors only) — that one is deliberately trimmed, not a duplicate of this.
 */
export interface Term {
  key: string;
  name: string;
}

export interface Categories {
  ministries: (Term & { abbreviation: string })[];
  sectors: Term[];
  themes: Term[];
  tags: Term[];
}
