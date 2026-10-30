import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { AppShell, helpFor } from "./AppShell";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function Where(): React.JSX.Element {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderAt(path: string, roles: string[], goto: (q: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@example.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/time-zone-check") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url.startsWith("/nrms/api/goto?q=")) return goto(decodeURIComponent(url.slice("/nrms/api/goto?q=".length)));
      return jsonResponse(404, { error: "not found" });
    }),
  );
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<Where />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return calls;
}

const box = () => screen.getByRole("textbox", { name: /Find a release/ });

describe("Find a release (side menu)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a reference number opens that release straight away", async () => {
    const user = userEvent.setup();
    const calls = renderAt("/releases/drafts", ["NRMS.Viewer"], (q) => (q === "NEWS-00007" ? jsonResponse(200, { id: "rel-7" }) : jsonResponse(404, {})));
    await screen.findByText("Signed in as Pat");
    await user.type(box(), " NEWS-00007 {Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/releases/rel-7"));
    expect(calls).toContain("/nrms/api/goto?q=NEWS-00007");
    expect(box()).toHaveValue("");
  });

  it("words that name no one release open the Search results for them", async () => {
    const user = userEvent.setup();
    renderAt("/releases/rel-1", ["NRMS.Editor"], () => jsonResponse(404, { error: "not found" }));
    await screen.findByText("Signed in as Pat");
    await user.type(box(), "child care");
    await user.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/search?q=child+care"));
  });

  it("an empty box goes nowhere and asks nothing of the server", async () => {
    const user = userEvent.setup();
    const calls = renderAt("/releases/drafts", ["NRMS.Viewer"], () => jsonResponse(404, {}));
    await screen.findByText("Signed in as Pat");
    await user.type(box(), "   {Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/releases/drafts");
    expect(calls.some((c) => c.startsWith("/nrms/api/goto"))).toBe(false);
  });

  it("says so when the server can't be asked, and stays put", async () => {
    const user = userEvent.setup();
    renderAt("/releases/drafts", ["NRMS.Viewer"], () => jsonResponse(500, { error: "boom" }));
    await screen.findByText("Signed in as Pat");
    await user.type(box(), "NEWS-1{Enter}");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/releases/drafts");
  });

  it("Ctrl+K (⌘K on a Mac) goes to it on a screen with no search box of its own", async () => {
    renderAt("/releases/rel-1", ["NRMS.Editor"], () => jsonResponse(404, {}));
    await screen.findByText("Signed in as Pat");
    expect(box()).toHaveAttribute("aria-keyshortcuts", "Control+K");
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(false);
    expect(box()).toHaveFocus();
  });

  it("isn't shown on Search (it has its own box) or to someone with no release role", async () => {
    renderAt("/search", ["NRMS.Viewer"], () => jsonResponse(404, {}));
    await screen.findByText("Signed in as Pat");
    expect(screen.queryByRole("search", { name: "Find a release" })).toBeNull();
    cleanup();
    renderAt("/subscribers", ["NoD.Editor"], () => jsonResponse(404, {}));
    await screen.findByText("Signed in as Pat");
    expect(screen.queryByRole("search", { name: "Find a release" })).toBeNull();
  });

  it("is a labelled search landmark with no axe violations", async () => {
    renderAt("/releases/drafts", ["NRMS.Viewer"], () => jsonResponse(404, {}));
    await screen.findByText("Signed in as Pat");
    const form = screen.getByRole("search", { name: "Find a release" });
    expect(within(form).getByText(/NEWS-00007/)).toBeInTheDocument();
    const results = await axe.run(form);
    expect(results.violations).toEqual([]);
  });
});

describe("the header's Help opens at the area you're in", () => {
  it.each([
    ["/releases/drafts", "/help#how-releases"],
    ["/releases/abc", "/help#how-releases"],
    ["/search", "/help#how-releases"],
    ["/website/carousel", "/help#how-website"],
    ["/subscribers/new", "/help#how-subscribers"],
    ["/calendar", "/help#how-calendar"],
    ["/calendar-access", "/help"],
    ["/users", "/help"],
  ])("%s → %s", (path, help) => {
    expect(helpFor(path)).toBe(help);
  });
});
