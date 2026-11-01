import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { AdminHistoryScreen } from "./AdminHistoryScreen";
import type { AuditEntry } from "./describe";

const entry = (id: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  at: "2026-01-15T17:00:00Z",
  actorId: "u1",
  actorName: "Paul Smith",
  action: "user.roles",
  targetType: "user",
  targetId: "jo",
  targetLabel: "Jo Lee",
  details: { added: ["Core.Admin"], removed: [] },
  ...over,
});

let location = "";
let navigate: ReturnType<typeof useNavigate> | null = null;
function Where(): null {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  navigate = useNavigate();
  return null;
}

function renderAt(path: string) {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <AnnouncerProvider>
          <RequireAuth>
            <Routes>
              <Route path="/admin-history" element={<><AdminHistoryScreen /><Where /></>} />
            </Routes>
          </RequireAuth>
        </AnnouncerProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

function stub(roles: string[], audit: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Paul Smith", email: "p@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/core/api/organizations") return jsonResponse(200, [{ key: "health", displayName: "Health" }]);
      if (url.startsWith("/core/api/audit?")) return audit(url);
      throw new Error(`unhandled: ${url}`);
    }),
  );
  return calls;
}

/** Suite review O3: every Core admin change, newest first, for Core administrators. */
describe("AdminHistoryScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists changes newest first as When, Who and What, in plain words and BC time", async () => {
    stub(["Core.Admin"], () =>
      jsonResponse(200, {
        items: [
          entry(2, { action: "calendar.access", details: { role: { from: null, to: "Calendar.Editor" }, added: ["health"], removed: [] } }),
          entry(1),
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      }),
    );
    renderAt("/admin-history");
    const table = await screen.findByRole("table", { name: "Admin history, newest first" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent?.replace(/\s/g, " ")));
    expect(rows).toEqual([
      ["Jan 15, 2026 9:00 AM", "Paul Smith", "Changed Jo Lee's Calendar access: gave them the Editor role; added Health"],
      ["Jan 15, 2026 9:00 AM", "Paul Smith", "Gave Core Admin to Jo Lee"],
    ]);
    expect(screen.getByText("2 changes")).toBeInTheDocument();
    // Announced through the Hub's one live region.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 changes"));
    expect(document.title).toContain("Admin history");
  });

  it("filters by who, what and dates, through the address, and pages", async () => {
    const calls = stub(["Core.Admin"], (url) => {
      const page = Number(new URL(url, "http://x").searchParams.get("page"));
      return jsonResponse(200, { items: [entry(page)], total: 120, page, pageSize: 50 });
    });
    const user = userEvent.setup();
    renderAt("/admin-history");
    await screen.findByRole("table");
    expect(calls.filter((c) => c.startsWith("/core/api/audit"))).toEqual(["/core/api/audit?page=1&pageSize=50"]);

    await user.type(screen.getByLabelText("Who"), " Paul ");
    await user.selectOptions(screen.getByLabelText("What"), "Users");
    await user.type(screen.getByLabelText("From"), "2026-01-01");
    await user.type(screen.getByLabelText("To"), "2026-01-31");
    await user.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(calls.at(-1)).toBe("/core/api/audit?who=Paul&kind=users&from=2026-01-01&to=2026-01-31&page=1&pageSize=50"));
    expect(location).toBe("/admin-history?who=Paul&kind=users&from=2026-01-01&to=2026-01-31");

    expect(await screen.findByText("Showing 1–50 of 120")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls.at(-1)).toBe("/core/api/audit?who=Paul&kind=users&from=2026-01-01&to=2026-01-31&page=2&pageSize=50"));
    expect(await screen.findByText("Showing 51–100 of 120")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(calls.at(-1)).toBe("/core/api/audit?page=1&pageSize=50"));
    expect(screen.getByLabelText("Who")).toHaveValue("");
  });

  it("refuses From after To without asking Core", async () => {
    const calls = stub(["Core.Admin"], () => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 50 }));
    const user = userEvent.setup();
    renderAt("/admin-history");
    expect(await screen.findByText("No changes recorded yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("From"), "2026-02-01");
    await user.type(screen.getByLabelText("To"), "2026-01-01");
    const before = calls.length;
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("From must be on or before To.");
    expect(calls.length).toBe(before);
  });

  it("says when nothing matches the filters, and when it can't load", async () => {
    stub(["Core.Admin"], () => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 50 }));
    renderAt("/admin-history?who=nobody");
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    stub(["Core.Admin"], () => jsonResponse(500, { error: "internal error" }));
    renderAt("/admin-history");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the admin history.");
  });

  it("keeps focus on Next and on Clear filters while the next result loads, and the fields follow Back", async () => {
    let release: (() => void) | null = null;
    stub(["Core.Admin"], (url) => {
      const page = Number(new URL(url, "http://x").searchParams.get("page"));
      return jsonResponse(200, { items: [entry(page)], total: 120, page, pageSize: 50 });
    });
    const realFetch = globalThis.fetch;
    // Hold the second page's answer, so the press is checked while it loads.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("page=2")) await new Promise<void>((r) => (release = r));
        return realFetch(url, init);
      }),
    );
    const user = userEvent.setup();
    renderAt("/admin-history?who=Paul");
    expect(await screen.findByText("Showing 1–50 of 120")).toBeInTheDocument();
    expect(screen.getByLabelText("Who")).toHaveValue("Paul");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(screen.getByRole("table").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    release!();
    expect(await screen.findByText("Showing 51–100 of 120")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("120 changes, showing 51 to 100"));

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Clear filters" })).toHaveFocus();
    await waitFor(() => expect(location).toBe("/admin-history"));
    expect(screen.getByLabelText("Who")).toHaveValue("");

    // Back to the filtered address: the Who field shows its filter again.
    act(() => void navigate!(-1));
    await waitFor(() => expect(screen.getByLabelText("Who")).toHaveValue("Paul"));
  });

  it("is for Core administrators only, and never asks Core otherwise", async () => {
    const calls = stub(["Calendar.SysAdmin"], () => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 50 }));
    renderAt("/admin-history");
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("/core/api/audit") || c === "/core/api/organizations")).toBe(false);
  });
});
