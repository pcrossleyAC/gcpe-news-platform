import { describe, expect, it } from "vitest";
import type { SessionValue } from "../session/SessionContext";
import { helpFor, helpTargetFor } from "./help-target";
import { FIXTURE, fixturePage } from "./test-fixtures";

const as = (...roles: string[]): SessionValue => ({ roles, has: (r: string) => roles.includes(r) }) as unknown as SessionValue;

describe("helpTargetFor", () => {
  it("opens a Core administrator's own page for a screen", () => {
    expect(helpTargetFor("/government-terms", as("Core.Admin"), FIXTURE)).toBe("/help/manuals/core-admin/government-terms");
  });
  it("gives a release editor the editor manual's page, not the site editor's", () => {
    expect(helpTargetFor("/releases/123", as("NRMS.Editor"), FIXTURE)).toBe("/help/manuals/nrms-editor/editor-releases");
  });
  it("puts the reader's own manual first when two pages match equally", () => {
    // The fixture's Site editor page and the viewer page both match /releases.
    expect(helpTargetFor("/releases/123", as("NRMS.SiteEditor"), FIXTURE)).toBe("/help/manuals/nrms-site-editor/site-editor-releases");
  });
  it("skips the release editor's pages for a reader who can't change releases", () => {
    const data = { pages: FIXTURE.pages.filter((p) => p.id !== "site-editor-releases") };
    expect(helpTargetFor("/releases/123", as("NRMS.SiteEditor"), data)).toBe("/help/manuals/nrms-viewer/viewer-overview");
    expect(helpTargetFor("/releases/scheduled", as("NRMS.SiteEditor"), data)).toBe("/help/manuals/nrms-viewer/viewer-overview");
    expect(helpTargetFor("/releases/123", as("NRMS.SiteEditor", "NRMS.Editor"), data)).toBe("/help/manuals/nrms-editor/editor-releases");
  });
  it("prefers the longest matching route", () => {
    expect(helpTargetFor("/releases/scheduled", as("NRMS.Editor"), FIXTURE)).toBe("/help/manuals/nrms-editor/editor-publishing");
  });
  it("matches whole path segments only", () => {
    expect(helpTargetFor("/releases-archive", as("NRMS.Editor"), FIXTURE)).toBe("/help");
  });
  it("never opens a page the reader cannot see, and falls back to the area's How do I", () => {
    expect(helpTargetFor("/calendar/activities", as("NRMS.Editor"), FIXTURE)).toBe("/help#how-calendar");
    expect(helpTargetFor("/government-terms", as("NRMS.Editor"), FIXTURE)).toBe("/help");
  });
  it("falls back to /help for a reader with no manuals", () => {
    expect(helpTargetFor("/releases", as(), FIXTURE)).toBe("/help#how-releases");
    expect(helpTargetFor("/users", as(), FIXTURE)).toBe("/help");
  });
  it("can open a visible topic page by its routes", () => {
    const data = { pages: [...FIXTURE.pages, fixturePage({ id: "signing-in-help", manual: "topic", routes: ["/sign-in"] })] };
    // Not listed by any page this reader can see, so not visible.
    expect(helpTargetFor("/sign-in", as("NRMS.Editor"), data)).toBe("/help");
    const linked = { pages: data.pages.map((p) => (p.id === "editor-releases" ? { ...p, topics: ["signing-in-help"] } : p)) };
    expect(helpTargetFor("/sign-in", as("NRMS.Editor"), linked)).toBe("/help/manuals/topic/signing-in-help");
  });
});

describe("helpFor", () => {
  it("is the area's How do I, or the whole page", () => {
    expect(helpFor("/releases/drafts")).toBe("/help#how-releases");
    expect(helpFor("/users")).toBe("/help");
  });
});

describe("Help on the release screens, with the compiled manuals", () => {
  const SCREENS: [string, string, string][] = [
    ["/releases/forecast", "viewer-release-folders", "editor-release-folders"],
    ["/releases/drafts", "viewer-release-folders", "editor-release-folders"],
    ["/releases/scheduled", "viewer-release-folders", "editor-release-folders"],
    ["/releases/published", "viewer-release-folders", "editor-release-folders"],
    ["/releases/123", "viewer-read-a-release", "editor-write-a-release"],
    ["/search", "viewer-find-a-release", "editor-find-a-release"],
    ["/website/featured", "viewer-featured-and-log", "editor-featured-and-log"],
    ["/website/log", "viewer-featured-and-log", "editor-featured-and-log"],
  ];
  it.each(SCREENS)("on %s, a release viewer gets %s and a release editor %s", (path, viewerPage, editorPage) => {
    expect(helpTargetFor(path, as("NRMS.Viewer"))).toBe(`/help/manuals/nrms-viewer/${viewerPage}`);
    expect(helpTargetFor(path, as("NRMS.Editor"))).toBe(`/help/manuals/nrms-editor/${editorPage}`);
  });
  // Site editors only read releases, so the release editor's pages don't fit them.
  const RELEASE_ROUTES: [string, string][] = [
    ["/releases", "viewer-read-a-release"],
    ["/releases/123", "viewer-read-a-release"],
    ["/releases/new", "viewer-read-a-release"],
    ["/releases/forecast", "viewer-release-folders"],
    ["/releases/drafts", "viewer-release-folders"],
    ["/releases/scheduled", "viewer-release-folders"],
    ["/releases/published", "viewer-release-folders"],
    ["/search", "viewer-find-a-release"],
  ];
  it.each(RELEASE_ROUTES)("on %s, a site editor gets the viewer's %s, not a release editor's page", (path, viewerPage) => {
    expect(helpTargetFor(path, as("NRMS.SiteEditor"))).toBe(`/help/manuals/nrms-viewer/${viewerPage}`);
    expect(helpTargetFor(path, as("NRMS.SiteEditor", "NRMS.Editor"))).toMatch(/^\/help\/manuals\/nrms-editor\//);
  });
});

describe("Help on the Website screens, with the compiled manuals", () => {
  // [path, the Site editor's page]. A Core administrator who is also a site editor gets the Site
  // editor's page, not the Core admin page that says Website is view-only for them.
  const SCREENS: [string, string][] = [
    ["/website/carousel", "carousel"],
    ["/website/pins", "emergency-pins"],
    ["/website/live-feed", "live-feed"],
    ["/website/links", "resource-links"],
    ["/website/files", "website-files"],
    ["/website/address-check", "hub-address-check"],
    ["/website/settings", "site-settings"],
    ["/website/settings-history", "site-settings"],
    ["/website/banner", "site-banner"],
    ["/website/footer", "footer-and-navigation"],
    ["/website/navigation", "footer-and-navigation"],
    ["/website/social", "social-links"],
    ["/website/theme", "theme-colours"],
    ["/website/ministry-pages", "ministry-pages-and-media-contacts"],
    ["/website/media-contacts", "ministry-pages-and-media-contacts"],
    ["/website/page-text", "page-text"],
    ["/website/identity", "site-identity"],
  ];
  it.each(SCREENS)("on %s, a Core administrator who is also a site editor gets %s", (path, page) => {
    expect(helpTargetFor(path, as("NRMS.SiteEditor"))).toBe(`/help/manuals/nrms-site-editor/${page}`);
    expect(helpTargetFor(path, as("Core.Admin", "NRMS.SiteEditor"))).toBe(`/help/manuals/nrms-site-editor/${page}`);
    expect(helpTargetFor(path, as("Core.Admin"))).toBe("/help/manuals/core-admin/website-project-blue-bridge");
  });
  it("keeps the Core admin page on Project Blue Bridge, the one switch only a Core administrator has", () => {
    expect(helpTargetFor("/website/blue-bridge", as("Core.Admin", "NRMS.SiteEditor"))).toBe("/help/manuals/core-admin/website-project-blue-bridge");
    expect(helpTargetFor("/website/blue-bridge", as("NRMS.SiteEditor"))).toBe("/help/manuals/nrms-site-editor/site-identity");
  });
  it("sends a Core administrator who is also a site editor to How do I on the Website landing, as a site editor", () => {
    expect(helpTargetFor("/website", as("Core.Admin", "NRMS.SiteEditor"))).toBe("/help#how-website");
    expect(helpTargetFor("/website", as("Core.Admin"))).toBe("/help/manuals/core-admin/website-project-blue-bridge");
  });
});

describe("Help on the Subscribers screens, with the compiled manuals", () => {
  const ID = "68270e0a-27b4-4ea9-aceb-c7a9cfacf657";
  const SCREENS: [string, string, string, string][] = [
    ["/subscribers", "nod-viewer-find-subscribers", "editor-find-and-change-subscribers", "find-and-change-subscribers"],
    [`/subscribers/${ID}`, "nod-viewer-find-subscribers", "editor-find-and-change-subscribers", "find-and-change-subscribers"],
    [`/subscribers/${ID}/history`, "nod-viewer-find-subscribers", "editor-find-and-change-subscribers", "find-and-change-subscribers"],
    ["/subscribers/new", "nod-viewer-overview", "editor-add-a-subscriber", "add-a-subscriber"],
    ["/subscribers/lists", "nod-viewer-lists-and-categories", "editor-lists-and-categories", "lists-and-categories"],
    ["/subscribers/media-lists", "nod-viewer-media-lists", "editor-media-lists", "subscriber-media-lists"],
    ["/subscribers/media-lists/201-e-legislature-press-gallery", "nod-viewer-media-lists", "editor-media-lists", "subscriber-media-lists"],
    ["/subscribers/reports", "nod-viewer-reports", "editor-subscriber-reports", "subscriber-reports"],
    ["/subscribers/reports/unsubscribes", "nod-viewer-reports", "editor-subscriber-reports", "subscriber-reports"],
    ["/subscribers/operations", "nod-viewer-overview", "nod-editor-overview", "subscriber-operations"],
  ];
  it.each(SCREENS)("on %s, a Subscribers viewer gets %s, an editor %s and an administrator %s", (path, viewerPage, editorPage, adminPage) => {
    expect(helpTargetFor(path, as("NoD.Viewer"))).toBe(`/help/manuals/nod-viewer/${viewerPage}`);
    expect(helpTargetFor(path, as("NoD.Editor"))).toBe(`/help/manuals/nod-editor/${editorPage}`);
    expect(helpTargetFor(path, as("NoD.Admin"))).toBe(`/help/manuals/nod-admin/${adminPage}`);
  });
});

describe("Help on the Calendar screens, with the compiled manuals", () => {
  // [path, read-only user's page, editor's page, advanced user's page, administrator's page]. Each
  // reader's own manual wins on an equal match: a read-only user gets the read-only pages, an editor
  // the editor pages, an advanced user the advanced ones. An administrator's own manual wins where it
  // has a page for the screen (an activity: Delete an activity); on the list and Updates the advanced
  // pages come first among the manuals below theirs.
  const SHARED: [string, string, string, string, string][] = [
    ["/calendar", "calendar-readonly-list", "calendar-editor-list", "calendar-advanced-list", "calendar-advanced/calendar-advanced-list"],
    ["/calendar/updates", "calendar-readonly-updates", "calendar-editor-updates", "calendar-advanced-updates", "calendar-advanced/calendar-advanced-updates"],
    ["/calendar/activities/new", "calendar-readonly-activity", "calendar-editor-activity", "calendar-advanced-activity", "calendar-admin/calendar-delete-activity"],
    ["/calendar/activities/12", "calendar-readonly-activity", "calendar-editor-activity", "calendar-advanced-activity", "calendar-admin/calendar-delete-activity"],
    ["/calendar/activities/12/changes", "calendar-readonly-activity", "calendar-editor-activity", "calendar-advanced-activity", "calendar-admin/calendar-delete-activity"],
  ];
  it.each(SHARED)("on %s, a read-only user gets %s, an editor %s, an advanced user %s and an administrator %s", (path, readOnlyPage, editorPage, page, adminPage) => {
    expect(helpTargetFor(path, as("Calendar.ReadOnly"))).toBe(`/help/manuals/calendar-readonly/${readOnlyPage}`);
    expect(helpTargetFor(path, as("NRMS.Editor", "Calendar.ReadOnly"))).toBe(`/help/manuals/calendar-readonly/${readOnlyPage}`);
    expect(helpTargetFor(path, as("Calendar.Editor"))).toBe(`/help/manuals/calendar-editor/${editorPage}`);
    expect(helpTargetFor(path, as("Calendar.Advanced"))).toBe(`/help/manuals/calendar-advanced/${page}`);
    expect(helpTargetFor(path, as("Calendar.Administrator"))).toBe(`/help/manuals/${adminPage}`);
    expect(helpTargetFor(path, as("Calendar.SysAdmin"))).toBe(`/help/manuals/${adminPage}`);
  });
  // Suite review O1.3: the Hub-wide Undelivered updates screen has its own Core administrator page.
  it("on /undelivered-updates, a Core administrator gets the Undelivered updates page", () => {
    expect(helpTargetFor("/undelivered-updates", as("Core.Admin"))).toBe("/help/manuals/core-admin/undelivered-updates");
  });
  const ADMIN: [string, string][] = [
    ["/calendar/users", "calendar-users"],
    ["/calendar/lookups/categories", "calendar-lookups"],
    ["/calendar/transfer", "calendar-transfer"],
    ["/calendar/dead-letters", "calendar-undelivered-events"],
  ];
  it.each(ADMIN)("on %s, an administrator still gets their own page %s", (path, page) => {
    expect(helpTargetFor(path, as("Calendar.SysAdmin"))).toBe(`/help/manuals/calendar-admin/${page}`);
  });
});

// Suite review H4: Page not found is a screen of its own now. An address no screen answers
// isn't any manual page's, so its Help is the whole Help page (or the area's How do I…).
describe("Help on Page not found, with the compiled manuals", () => {
  it("opens the Help page, or the area's How do I", () => {
    expect(helpTargetFor("/no-such-screen", as("Core.Admin"))).toBe("/help");
    expect(helpTargetFor("/subscribers/no/such/screen", as("NoD.Editor"))).toBe("/help/manuals/nod-editor/editor-find-and-change-subscribers");
  });
});

describe("Help on Admin history, with the compiled manuals", () => {
  it("opens the Core admin manual's Admin history page", () => {
    expect(helpTargetFor("/admin-history", as("Core.Admin"))).toBe("/help/manuals/core-admin/admin-history");
    expect(helpTargetFor("/admin-history", as("NRMS.Editor"))).toBe("/help");
  });
});
