import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { jsonResponse } from "../../../../test/jsonResponse";
import { stubFetch } from "../list/fixtures";
import { answerFeed, feedPage, item, renderUpdates } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the Updates screen in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("entries, a deleted one among them, cut at 1,000", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ truncated: true, items: [item(), item({ id: 2, action: "deleted", isDeleted: true, title: "Sample gone" })] }))) });
    const { container } = renderUpdates();
    await screen.findByText("Sample gone");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("no entries", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [] }))) });
    const { container } = renderUpdates("/calendar/updates?mode=latest");
    await screen.findByText("No updates.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("an activity not found", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(404, { error: "not found" })) });
    const { container } = renderUpdates("/calendar/updates?mode=activity&activity=20001");
    await screen.findByText("Activity not found: it doesn't exist, or you can't see it.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the feed failing to load", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(500, { error: "boom" })) });
    const { container } = renderUpdates();
    await screen.findByText("Couldn't load the updates.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the form's own error shown", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("From must be on or before To.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a hand-edited address", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates("/calendar/updates?mode=bogus");
    await screen.findByText("That address isn't one of the updates views.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
