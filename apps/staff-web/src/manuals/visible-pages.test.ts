import { describe, expect, it } from "vitest";
import type { SessionValue } from "../session/SessionContext";
import { canOpenManual, canOpenPage, visiblePages } from "./visible-pages";
import { FIXTURE } from "./test-fixtures";

const as = (...roles: string[]): SessionValue => ({ roles, has: (r: string) => roles.includes(r) }) as unknown as SessionValue;

describe("what a reader may open", () => {
  it("opens manuals by the catalog's visibility", () => {
    expect(canOpenManual("nrms-editor", as("NRMS.Editor"))).toBe(true);
    expect(canOpenManual("nrms-site-editor", as("NRMS.Editor"))).toBe(false);
    expect(canOpenManual("nope", as("Core.Admin"))).toBe(false);
  });
  it("opens a topic page only when a page the reader can see lists it", () => {
    expect(canOpenPage(FIXTURE, "topic", "signing-in", as("NRMS.Editor"))).toBe(true);
    expect(canOpenPage(FIXTURE, "topic", "site-editor-only-topic", as("NRMS.Editor"))).toBe(false);
    expect(canOpenPage(FIXTURE, "topic", "site-editor-only-topic", as("NRMS.SiteEditor"))).toBe(true);
    expect(canOpenPage(FIXTURE, "topic", "signing-in", as())).toBe(false);
  });
  it("opens a manual page only in its own manual, and only for a reader who can open that manual", () => {
    expect(canOpenPage(FIXTURE, "nrms-editor", "editor-releases", as("NRMS.Editor"))).toBe(true);
    expect(canOpenPage(FIXTURE, "nrms-viewer", "editor-releases", as("NRMS.Editor"))).toBe(false);
    expect(canOpenPage(FIXTURE, "nrms-site-editor", "site-editor-releases", as("NRMS.Editor"))).toBe(false);
  });
  it("lists the visible pages with the reader's own manual first", () => {
    expect(visiblePages(FIXTURE, as("NRMS.Editor", "Calendar.ReadOnly")).map((p) => p.id)).toEqual([
      "editor-releases",
      "editor-publishing",
      "calendar-readonly-overview",
      "viewer-overview",
      "signing-in",
    ]);
  });
});
