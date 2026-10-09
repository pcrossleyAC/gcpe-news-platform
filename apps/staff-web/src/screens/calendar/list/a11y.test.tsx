import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { CONFIG, renderList, row, stubFetch } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity list in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("rows, with review markup", async () => {
    stubFetch([], { page: () => ({ rows: [row({ needsReview: ["title"], isShared: true, hasRelease: true, keywords: ["Sample tag"] })], total: 1, offset: 0 }) });
    const { container } = renderList();
    await screen.findByText("Sample listed");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("no rows, and the freeze in force", async () => {
    stubFetch([], { page: () => ({ rows: [], total: 0, offset: 0 }), config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } });
    const { container } = renderList();
    await screen.findByText("No activities match.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the list failing to load", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list?") ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await screen.findByText("Couldn't load activities.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the column chooser open, and a filter error shown", async () => {
    stubFetch([]);
    const { container } = renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("From must be on or before To.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
