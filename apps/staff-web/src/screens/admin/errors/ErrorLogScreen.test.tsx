import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { ErrorLogScreen } from "./ErrorLogScreen";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

// Suite review O2.3: the screen asks for identical messages grouped, newest group first.
const GROUPS = [
  { message: "emergency feed check failed: HTTP 500", count: 212, firstAt: "2026-10-04T10:00:00.000Z", lastAt: "2026-10-05T12:00:00.000Z", pid: 111, startedAt: "2026-10-04T00:00:00.000Z" },
  { message: "first error", count: 1, firstAt: "2026-10-05T10:00:00.000Z", lastAt: "2026-10-05T10:00:00.000Z", pid: 111, startedAt: "2026-10-05T00:00:00.000Z" },
];
const GROUPED_URL = "/stack/errors?group=1&limit=200";

describe("ErrorLogScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === GROUPED_URL) return jsonResponse(200, { groups: GROUPS, entries: 213 });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<ErrorLogScreen />));
    await screen.findByRole("heading", { name: "Error log", level: 1 });
    await waitFor(() => expect(document.title).toBe("Error log — GCPE News Staff"));
  });

  it("shows each error once, newest first, with how often it happened, and a Refresh button that re-fetches", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === GROUPED_URL) return jsonResponse(200, { groups: GROUPS, entries: 213 });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<ErrorLogScreen />));
    await screen.findByText("first error");

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; the group seen most recently comes first.
    expect(rows[1]).toHaveTextContent("emergency feed check failed: HTTP 500");
    expect(rows[1]).toHaveTextContent(/212 times, first .*Oct.* 4/);
    expect(rows[2]).toHaveTextContent("first error");
    expect(rows[2]).toHaveTextContent("Once");

    const before = calls.filter((u) => u === GROUPED_URL).length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter((u) => u === GROUPED_URL).length).toBe(before + 1));
  });

  it("a non-Core.Admin is blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        return jsonResponse(200, {});
      }),
    );
    render(withAuth(<ErrorLogScreen />));
    await screen.findByText("You don’t have permission to view this page.");
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });
});
