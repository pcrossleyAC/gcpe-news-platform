import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { CalendarErrorBoundary } from "./ErrorBoundary";

function Explodes(): React.JSX.Element {
  throw new Error("boom");
}

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("CalendarErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders its children when nothing throws", () => {
    render(
      <CalendarErrorBoundary>
        <p>Sample content</p>
      </CalendarErrorBoundary>,
    );
    expect(screen.getByText("Sample content")).toBeInTheDocument();
  });

  it("shows a recoverable message with a Reload button instead of a blank page when a child throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <CalendarErrorBoundary>
        <Explodes />
      </CalendarErrorBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("This section couldn’t be shown.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("reloads on click, through the given reload function rather than any logged detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReload = vi.fn();
    render(
      <CalendarErrorBoundary onReload={onReload}>
        <Explodes />
      </CalendarErrorBoundary>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
