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
  it("gives a site editor their own manual's page, ahead of the lower manuals that match as well", () => {
    expect(helpTargetFor("/releases/123", as("NRMS.SiteEditor"), FIXTURE)).toBe("/help/manuals/nrms-site-editor/site-editor-releases");
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
