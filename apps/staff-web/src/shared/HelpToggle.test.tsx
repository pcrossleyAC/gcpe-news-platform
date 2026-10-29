import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { HelpToggle } from "./HelpToggle";
import { GLOSSARY } from "./glossary";

describe("HelpToggle", () => {
  afterEach(() => cleanup());

  it("is a button named for what it explains; pressing it (or Enter/Space) shows the glossary's text, with a link to Help", async () => {
    render(
      <MemoryRouter>
        <label htmlFor="x">LA Status</label>
        <HelpToggle entry="la-status" />
        <select id="x" />
      </MemoryRouter>,
    );
    const button = screen.getByRole("button", { name: "What is LA Status?" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeVisible();
    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent(GLOSSARY.find((e) => e.id === "la-status")!.definition);
    expect(screen.getByRole("link", { name: "More in Help" })).toHaveAttribute("href", "/help#glossary-la-status");
    await user.keyboard(" ");
    expect(panel).not.toBeVisible();
  });

  it("has no serious/critical axe violations, open", async () => {
    const { container } = render(
      <MemoryRouter>
        <HelpToggle entry="m3u-url" />
      </MemoryRouter>,
    );
    await userEvent.setup().click(screen.getByRole("button"));
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  it("every glossary entry has a unique id", () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
