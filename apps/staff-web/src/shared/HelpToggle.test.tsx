import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { HelpToggle } from "./HelpToggle";
import { GLOSSARY } from "./glossary";

/** The "?" (a <summary>: browsers expose it as a button; jsdom gives it no role). */
const toggle = (term: string) => screen.getByText(`What is ${term}?`).closest("summary")!;

describe("HelpToggle", () => {
  afterEach(() => cleanup());

  it("is a disclosure named for what it explains; Enter shows the glossary's text with a link to Help, and closes it again", async () => {
    render(
      <MemoryRouter>
        <label htmlFor="x">LA Status</label>
        <HelpToggle entry="la-status" />
        <select id="x" />
      </MemoryRouter>,
    );
    const summary = toggle("LA Status");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    const user = userEvent.setup();
    await user.tab();
    expect(summary).toHaveFocus();
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent(GLOSSARY.find((e) => e.id === "la-status")!.definition);
    expect(screen.getByRole("link", { name: "More in Help" })).toHaveAttribute("href", "/help#glossary-la-status");
    await user.click(summary);
    expect(details.open).toBe(false);
  });

  it("still opens inside a disabled (read-only) fieldset", async () => {
    render(
      <MemoryRouter>
        <fieldset disabled>
          <HelpToggle entry="comm-contact" />
        </fieldset>
      </MemoryRouter>,
    );
    // (user-event treats everything in a disabled fieldset as disabled; browsers don't disable a
    // summary — checked in Chromium on the review hub.)
    fireEvent.click(toggle("Comm Contact"));
    expect(toggle("Comm Contact").closest("details")!.open).toBe(true);
  });

  it("has no serious/critical axe violations, open", async () => {
    const { container } = render(
      <MemoryRouter>
        <HelpToggle entry="m3u-url" />
      </MemoryRouter>,
    );
    await userEvent.setup().click(toggle("M3U URL"));
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  it("every glossary entry has a unique id", () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
