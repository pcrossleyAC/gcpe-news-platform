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

const ENTRIES = [
  { timestamp: "2026-10-05T10:00:00.000Z", message: "first error", pid: 111, startedAt: "2026-10-05T00:00:00.000Z" },
  { timestamp: "2026-10-05T12:00:00.000Z", message: "second error", pid: 111, startedAt: "2026-10-05T00:00:00.000Z" },
];

describe("ErrorLogScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("renders entries newest first, with a Refresh button that re-fetches", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/stack/errors?limit=200") return jsonResponse(200, { errors: ENTRIES });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<ErrorLogScreen />));
    await screen.findByText("second error");

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; the newest entry ("second error") must come first.
    expect(rows[1]).toHaveTextContent("second error");
    expect(rows[2]).toHaveTextContent("first error");

    const before = calls.filter((u) => u === "/stack/errors?limit=200").length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter((u) => u === "/stack/errors?limit=200").length).toBe(before + 1));
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
