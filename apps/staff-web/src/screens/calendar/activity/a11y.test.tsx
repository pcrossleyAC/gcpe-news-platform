import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity editor in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("editing", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("HQ, with the Look Ahead fieldset overridden and review markup", async () => {
    const la = { hqComments: "", hqStatus: "new" as const, hqSection: "not_on_la" as const, longTermOutlook: true };
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["title"], fields: { ...FIELDS, lookAhead: la }, lookAhead: { ...la, inferred: { kind: "section", section: "in_the_news" } } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("button", { name: "Use the inferred section" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("read-only under someone else's lock", async () => {
    stubActivity([], { view: view({ lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByText("Sample Admin is editing this activity", { exact: false });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the error summary", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.clear(await screen.findByRole("textbox", { name: "Title" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Fix these to save");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a new activity", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/new");
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
