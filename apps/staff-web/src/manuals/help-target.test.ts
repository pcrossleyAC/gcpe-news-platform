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
