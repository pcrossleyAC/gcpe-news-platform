import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarUsersScreen } from "./CalendarUsersScreen";

const ROWS = [
  { userId: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKey: "finance", ministryAbbreviation: "FIN", rank: null },
  { userId: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKey: "health", ministryAbbreviation: "HLTH", rank: 4 },
];

function stub(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url.startsWith("/calendar/api/users")) return jsonResponse(200, url.includes("inactive=1") ? [...ROWS, { ...ROWS[1], userId: "u2", displayName: "Kim Imported", email: null, isActive: false, rank: null }] : ROWS);
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/users"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/users" element={<CalendarUsersScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("CalendarUsersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists user × ministry rows as legacy did, with each ministry's rank", async () => {
    stub([]);
    renderScreen();
    await waitFor(() => expect(document.title).toBe("Calendar users — GCPE News Staff"));
    expect(await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" })).toHaveAttribute("href", "/calendar/users/u1");
    expect(screen.getByRole("link", { name: "Robin Staff (FIN)" })).toBeInTheDocument();
  });

  it("asks for inactive users, including those with no email, when the switch is on", async () => {
    const calls: string[] = [];
    stub(calls);
    renderScreen();
    await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" });
    await userEvent.setup().click(screen.getByLabelText("Show inactive users, including those with no email"));
    expect(await screen.findByRole("link", { name: "Kim Imported (HLTH) — inactive" })).toBeInTheDocument();
    expect(calls).toContain("/calendar/api/users?inactive=1");
  });
});
