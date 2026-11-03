import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";

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

/** What the release screens need from Core's organization list (`GET /core/api/organizations`). */
export interface OrgFlags {
  key: string;
  parentKey: string | null;
  isPublic: boolean;
}

/** Legacy's own test (ReleaseModel.cs, NewModel.cs): a ministry named "… Minister of State for …". */
const MINISTER_OF_STATE = /minister of state for/i;

/**
 * The ministries a release can be filed under (C326). Legacy's checklists left out the Ministers
 * of State, and its news ministry list never held GCPE Headquarters or GCPE Media Relations. Ours
 * leave out an organization that isn't public, or that is a minister of state: it has a parent
 * ministry, or its name passes legacy's test. One already on the release (`keep`) stays, so it can
 * be unticked. Without Core's list (`orgs` null: not loaded, or it failed) only the name test applies.
 */
export function releaseMinistries<T extends Term>(ministries: T[], orgs: OrgFlags[] | null, keep: string[]): T[] {
  const flags = new Map((orgs ?? []).map((o) => [o.key.toLowerCase(), o]));
  return ministries.filter((m) => {
    if (keep.includes(m.key)) return true;
    const org = flags.get(m.key.toLowerCase());
    return !MINISTER_OF_STATE.test(m.name) && org?.parentKey == null && org?.isPublic !== false;
  });
}

/** Core's organization flags for {@link releaseMinistries}; null until loaded, or if it fails. */
export function useOrgFlags(): OrgFlags[] | null {
  const [orgs, setOrgs] = useState<OrgFlags[] | null>(null);
  useEffect(() => {
    let active = true;
    apiFetch<OrgFlags[]>("/core/api/organizations").then(
      (all) => active && setOrgs(all),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  return orgs;
}
