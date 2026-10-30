import { describe, expect, it } from "vitest";
import { missingManualUpdates } from "./check-manuals-current.mjs";

const terms = { id: "government-terms", path: "docs/manuals/core-admin/government-terms.md", screens: ["admin/government-terms"] };
const orgs = { id: "organizations", path: "docs/manuals/core-admin/organizations.md", screens: ["admin/organizations"] };
const both = { id: "terms-overview", path: "docs/manuals/topics/terms-overview.md", screens: ["admin/government-terms"] };
const screen = "apps/staff-web/src/screens/admin/government-terms/StartTermForm.tsx";

describe("missingManualUpdates", () => {
  it("names the folder and the covering pages when a screen changes without its manual", () => {
    const out = missingManualUpdates([screen], [terms, both, orgs], ["Change the form"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("admin/government-terms");
    expect(out[0]).toContain("government-terms");
    expect(out[0]).toContain("terms-overview");
    expect(out[0]).not.toContain("organizations");
    expect(out[0]).toContain("Manual: no change");
  });

  it("passes when a page naming that folder changed too", () => {
    expect(missingManualUpdates([screen, terms.path], [terms, both], [])).toEqual([]);
    expect(missingManualUpdates([screen, both.path], [terms, both], [])).toEqual([]);
  });

  it("does not count a page that names a different folder", () => {
    expect(missingManualUpdates([screen, orgs.path], [terms, orgs], [])).toHaveLength(1);
  });

  it("ignores test files", () => {
    const files = ["apps/staff-web/src/screens/admin/government-terms/StartTermForm.test.tsx", "apps/staff-web/src/screens/admin/government-terms/a11y.test.ts"];
    expect(missingManualUpdates(files, [terms], [])).toEqual([]);
  });

  it("is exempted by a commit line exactly `Manual: no change`", () => {
    expect(missingManualUpdates([screen], [terms], ["Tidy the form\n\nManual: no change\n"])).toEqual([]);
    expect(missingManualUpdates([screen], [terms], ["Tidy\r\n\r\nManual: no change\r\n"])).toEqual([]);
    expect(missingManualUpdates([screen], [terms], ["Tidy\n\nManual: no change please"])).toHaveLength(1);
    expect(missingManualUpdates([screen], [terms], ["manual: no change"])).toHaveLength(1);
  });

  it("does not check a folder no page names", () => {
    expect(missingManualUpdates(["apps/staff-web/src/screens/help/Help.tsx", "apps/staff-web/src/screens/SignIn.tsx"], [terms], [])).toEqual([]);
  });

  it("matches a named folder exactly or as a prefix at a folder boundary", () => {
    const base = "apps/staff-web/src/screens/admin/";
    expect(missingManualUpdates([`${base}organizations/sub/x.tsx`], [orgs], [])).toHaveLength(1);
    expect(missingManualUpdates([`${base}organizations/x.tsx`], [orgs], [])).toHaveLength(1);
    expect(missingManualUpdates([`${base}organizations-x/x.tsx`], [orgs], [])).toEqual([]);
    expect(missingManualUpdates([`${base}organizations.tsx`], [orgs], [])).toEqual([]);
  });

  it("gives one message per folder at fault", () => {
    const out = missingManualUpdates([screen, "apps/staff-web/src/screens/admin/organizations/List.tsx"], [terms, orgs], []);
    expect(out).toHaveLength(2);
  });

  it("counts a deleted page as a change to the pages that named the folder", () => {
    const gone = { id: "old-terms", path: "docs/manuals/core-admin/old-terms.md", screens: ["admin/government-terms"] };
    expect(missingManualUpdates([screen, gone.path], [terms, gone], [])).toEqual([]);
    // A deleted page for another folder does not help.
    const other = { id: "old-orgs", path: "docs/manuals/core-admin/old-orgs.md", screens: ["admin/organizations"] };
    expect(missingManualUpdates([screen, other.path], [terms, other], [])).toHaveLength(1);
  });

  it("ignores changes outside the screens folder", () => {
    expect(missingManualUpdates(["apps/staff-web/src/shell/nav.ts", "README.md"], [terms], [])).toEqual([]);
  });
});
