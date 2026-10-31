import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { missingManualUpdates } from "./check-manuals-current.mjs";
import { parsePage, readManualPages } from "./manuals-lib.mjs";

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

  it("checks a file only against the narrowest folder a page names", () => {
    const website = { id: "carousel", path: "docs/manuals/nrms-site-editor/carousel.md", screens: ["website"] };
    const settings = { id: "site-banner", path: "docs/manuals/nrms-site-editor/site-banner.md", screens: ["website/settings"] };
    const banner = "apps/staff-web/src/screens/website/settings/BannerScreen.tsx";
    expect(missingManualUpdates([banner, settings.path], [website, settings], [])).toEqual([]);
    // The broad page doesn't cover a folder that has its own page.
    const out = missingManualUpdates([banner, website.path], [website, settings], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("website/settings (");
    expect(out[0]).not.toContain("carousel");
    // A file outside the narrower folder still belongs to the broad one.
    expect(missingManualUpdates(["apps/staff-web/src/screens/website/CarouselScreen.tsx", settings.path], [website, settings], [])).toHaveLength(1);
    expect(missingManualUpdates(["apps/staff-web/src/screens/website/CarouselScreen.tsx", website.path], [website, settings], [])).toEqual([]);
  });

  it("ignores changes outside the screens folder", () => {
    expect(missingManualUpdates(["apps/staff-web/src/shell/nav.ts", "README.md"], [terms], [])).toEqual([]);
  });
});

describe("missingManualUpdates on the real manual pages", () => {
  const pages = readManualPages().map(({ path, text }) => {
    const { header } = parsePage(path, text);
    return { id: header.id, path, screens: header.screens };
  });
  const S = "apps/staff-web/src/screens/";
  it.each([
    ["website/settings/BannerScreen.tsx", "docs/manuals/nrms-site-editor/site-banner.md"],
    ["subscribers/reports/UnsubscribesReportScreen.tsx", "docs/manuals/nod-admin/subscriber-reports.md"],
    ["subscribers/reports/UnsubscribesReportScreen.tsx", "docs/manuals/nod-viewer/reports.md"],
  ])("passes a change to %s with %s", (screenFile, page) => {
    expect(pages.some((p) => p.path === page)).toBe(true);
    expect(missingManualUpdates([`${S}${screenFile}`, page], pages, [])).toEqual([]);
  });
  it("still fails a nested screen changed with only a page for the broad folder", () => {
    expect(missingManualUpdates([`${S}website/settings/BannerScreen.tsx`, "docs/manuals/nrms-site-editor/carousel.md"], pages, [])).toHaveLength(1);
  });
});

describe("check-manuals-current CLI", () => {
  const script = join(import.meta.dirname, "check-manuals-current.mjs");
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const page = (id: string, screens: string[]) => `---\nid: ${id}\ntitle: ${id}\nmanual: core-admin\norder: 1\nroutes: []\nscreens: [${screens.join(", ")}]\ntopics: []\n---\nBody.\n`;
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "manuals-ci-"));
    dirs.push(dir);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", ...a], { cwd: dir, encoding: "utf8" });
    const write = (p: string, t: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    git("init", "-q", "-b", "main");
    const commit = (m: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", m);
    };
    const run = () => spawnSync("node", [script, "--base", "main"], { cwd: dir, encoding: "utf8" });
    return { git, write, commit, run, dir };
  }
  const S = "apps/staff-web/src/screens";

  it("checks a screen file whose name has non-ASCII characters", () => {
    const r = repo();
    r.write("docs/manuals/core-admin/terms.md", page("terms", ["admin/terms"]));
    r.write(`${S}/admin/terms/a.tsx`, "x");
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.write(`${S}/admin/terms/é.tsx`, "y");
    r.commit("add screen");
    const out = r.run();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("admin/terms");
    expect(out.stderr).toContain("terms");
  });

  it("flags a file moved out of a covered folder", () => {
    const r = repo();
    r.write("docs/manuals/core-admin/terms.md", page("terms", ["admin/terms"]));
    r.write(`${S}/admin/terms/Form.tsx`, "same content, long enough to be detected as a rename\n".repeat(5));
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    mkdirSync(join(r.dir, S, "admin/other"), { recursive: true });
    r.git("mv", `${S}/admin/terms/Form.tsx`, `${S}/admin/other/Form.tsx`);
    r.commit("move");
    const out = r.run();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("admin/terms");
  });

  it("reads a deleted page from the merge base when main has moved on", () => {
    const r = repo();
    r.write("docs/manuals/core-admin/old.md", page("old", ["admin/terms"]));
    r.write("docs/manuals/core-admin/keep.md", page("keep", ["admin/terms"]));
    r.write(`${S}/admin/terms/a.tsx`, "x");
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.git("rm", "-q", "docs/manuals/core-admin/old.md");
    r.write(`${S}/admin/terms/a.tsx`, "changed");
    r.commit("delete the page and change the screen");
    r.git("checkout", "-q", "main");
    r.write("docs/manuals/core-admin/old.md", page("old", ["admin/elsewhere"]));
    r.write("unrelated.txt", "main moved");
    r.commit("main moves on");
    r.git("checkout", "-q", "feature");
    const out = r.run();
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
  });
});
