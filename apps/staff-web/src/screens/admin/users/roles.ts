/**
 * The checkbox list for "set roles" (task-5-brief.md), with a one-line plain-language
 * description per role for a Core.Admin who isn't necessarily steeped in the role names
 * themselves. Can't import `STAFF_ROLES` from `@gcpe/auth` directly — that package's only
 * export surface is its `index.ts` barrel (see its `package.json`'s `exports`), which pulls in
 * `express`/`jose` (Node-only) through `bearer.ts`/`session.ts`; browser code may never import
 * those (constraints.md). `roles.test.ts` (a node-environment test, since it ends in `.ts` not
 * `.tsx` — see vitest.config.ts's two projects) imports `packages/auth/src/roles.ts` directly,
 * bypassing that barrel, to check this list stays equal to the server's.
 */
export interface StaffRoleInfo {
  role: string;
  description: string;
}

export const STAFF_ROLES: StaffRoleInfo[] = [
  { role: "Core.Admin", description: "Manage staff users, Project Blue Bridge, and the error log." },
  { role: "NRMS.Editor", description: "Create, edit, and publish news releases." },
  { role: "NRMS.SiteEditor", description: "Edit the public website's carousel, pins, Live Feed, links, and files." },
  { role: "NRMS.Viewer", description: "View news releases and the website, with no editing." },
  { role: "NoD.Viewer", description: "Search News on Demand subscribers and see their history, read-only." },
  { role: "NoD.Editor", description: "Add, edit, deactivate and delete News on Demand subscribers." },
  { role: "NoD.Admin", description: "Everything a NoD Editor can do, plus News on Demand operations and list categories." },
  { role: "Distribution.Send", description: "Send media distribution emails." },
];

/** The role's area and name, shortened for a badge ("NRMS.SiteEditor" → "NRMS Site editor"). Also Admin history's wording. */
export const roleBadge = (role: string): string => {
  const [area, name = ""] = role.split(".");
  return `${area} ${name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`)}`.trim();
};
