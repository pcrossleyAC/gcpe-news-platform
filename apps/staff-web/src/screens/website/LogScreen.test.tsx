import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../test/jsonResponse";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { LogScreen } from "./LogScreen";
import type { SiteLogEntry } from "./types";

const ENTRIES: SiteLogEntry[] = [
  { at: "2026-10-05T12:00:00.000Z", actorName: "Pat", area: "carousel", text: "Saved the live carousel" },
];

describe("LogScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url.startsWith("/nrms/api/site/log")) return jsonResponse(200, ENTRIES);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(<LogScreen />);
    await screen.findByRole("heading", { name: "Website log", level: 1 });
    await waitFor(() => expect(document.title).toBe("Website log — GCPE News Staff"));
  });

  it("loads the unfiltered log, then refetches with the chosen area", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nrms/api/site/log?limit=200") return jsonResponse(200, ENTRIES);
        if (url === "/nrms/api/site/log?area=blue-bridge&limit=200") return jsonResponse(200, []);
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(<LogScreen />);
    await screen.findByText("Saved the live carousel");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Filter by area"), "Project Blue Bridge");

    await waitFor(() => expect(calls).toContain("/nrms/api/site/log?area=blue-bridge&limit=200"));
    await screen.findByText("No log entries yet.");
  });

  it("labels site settings entries and offers them as a filter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url.startsWith("/nrms/api/site/log")) return jsonResponse(200, [{ at: "2026-10-05T12:00:00.000Z", actorName: "Pat", area: "settings", text: "Published revision 1" }]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(<LogScreen />);
    await screen.findByText("Published revision 1");
    expect(screen.getByRole("cell", { name: "Site settings" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Site settings" })).toHaveValue("settings");
  });

  const asRoles = (roles: string[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url.startsWith("/nrms/api/site/log")) return jsonResponse(200, [{ at: "2026-10-05T12:00:00.000Z", actorName: "Pat", area: "government-terms", text: "Added a government term starting November 20, 2028" }]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
  const withSession = () => (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <LogScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );

  it("labels Government terms entries and offers them as a filter, to Core administrators", async () => {
    asRoles(["Core.Admin"]);
    render(withSession());
    await screen.findByText("Added a government term starting November 20, 2028");
    expect(screen.getByRole("cell", { name: "Government terms" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Government terms" })).toHaveValue("government-terms");
  });

  it("doesn't offer the Government terms filter to a site editor", async () => {
    asRoles(["NRMS.SiteEditor"]);
    render(withSession());
    expect(await screen.findByRole("option", { name: "Carousel" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Government terms" })).toBeNull();
  });
});
