import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEscapeClosesPanels } from "./escapeClosesPanels";

function Panels(): React.JSX.Element {
  useEscapeClosesPanels();
  const [open, setOpen] = useState(true);
  return (
    <>
      <button aria-expanded={open} aria-controls="panel" onClick={() => setOpen((o) => !o)}>
        Schedule
      </button>
      <div id="panel" hidden={!open}>
        <input aria-label="Date" />
        <input aria-label="Find" type="search" defaultValue="clinics" />
      </div>
      <details open>
        <summary>Filters</summary>
        <input aria-label="Search for" />
      </details>
      <div role="dialog" aria-label="A dialog">
        <input aria-label="In dialog" />
      </div>
    </>
  );
}

const esc = () => fireEvent.keyDown(document.activeElement!, { key: "Escape" });

describe("Esc closes the panel you're in", () => {
  afterEach(() => cleanup());

  it("from inside a toggled panel: closes it through its own toggle, and focus goes back to the toggle", () => {
    render(<Panels />);
    screen.getByLabelText("Date").focus();
    esc();
    const toggle = screen.getByRole("button", { name: "Schedule" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("from the toggle itself, while open", () => {
    render(<Panels />);
    const toggle = screen.getByRole("button", { name: "Schedule" });
    toggle.focus();
    esc();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("from inside an open <details>: closes it, focus to its summary", () => {
    render(<Panels />);
    screen.getByLabelText("Search for").focus();
    esc();
    const details = screen.getByText("Filters").closest("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("Filters")).toHaveFocus();
  });

  it("leaves a search box's own Esc (clear it) alone while it has text", () => {
    render(<Panels />);
    screen.getByLabelText("Find").focus();
    esc();
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves dialogs to their own Esc handling", () => {
    render(<Panels />);
    screen.getByLabelText("In dialog").focus();
    esc();
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Filters").closest("details")!.open).toBe(true);
  });

  it("does nothing for an Esc something else already handled", () => {
    render(<Panels />);
    const date = screen.getByLabelText("Date");
    date.addEventListener("keydown", (e) => e.preventDefault());
    date.focus();
    esc();
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-expanded", "true");
  });
});
