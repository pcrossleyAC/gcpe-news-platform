import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { useFocusH1OnRouteChange } from "./useFocusH1OnRouteChange";

/** Stands in for a screen that renders "Loading…" (no h1 at all) before its h1 appears a tick
 * later — the gap useFocusH1OnRouteChange's MutationObserver fallback exists for. */
function Slow() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(id);
  }, []);
  return ready ? <h1>Screen C</h1> : <p>Loading…</p>;
}

function Shell() {
  const ref = useFocusH1OnRouteChange<HTMLElement>();
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate("/b")}>
        Go to B
      </button>
      <button type="button" onClick={() => navigate("/c")}>
        Go to C (slow)
      </button>
      <main ref={ref}>
        <Routes>
          <Route path="/a" element={<h1>Screen A</h1>} />
          <Route path="/b" element={<h1>Screen B</h1>} />
          <Route path="/c" element={<Slow />} />
        </Routes>
      </main>
    </div>
  );
}

function renderShell(initialPath = "/a") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Shell />
    </MemoryRouter>,
  );
}

describe("useFocusH1OnRouteChange (I5)", () => {
  afterEach(cleanup);

  it("focuses the h1 (tabIndex -1) on the initial route", async () => {
    renderShell("/a");
    const h1 = await screen.findByRole("heading", { name: "Screen A", level: 1 });
    expect(h1).toHaveFocus();
    expect(h1).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus to the new screen's h1 after navigating", async () => {
    renderShell("/a");
    await screen.findByRole("heading", { name: "Screen A", level: 1 });
    act(() => screen.getByRole("button", { name: "Go to B" }).click());
    const h1 = await screen.findByRole("heading", { name: "Screen B", level: 1 });
    expect(h1).toHaveFocus();
  });

  it("still finds the h1 once it appears later (a screen that shows Loading… first)", async () => {
    renderShell("/a");
    await screen.findByRole("heading", { name: "Screen A", level: 1 });
    act(() => screen.getByRole("button", { name: "Go to C (slow)" }).click());
    await screen.findByText("Loading…");
    const h1 = await screen.findByRole("heading", { name: "Screen C", level: 1 });
    expect(h1).toHaveFocus();
  });
});
