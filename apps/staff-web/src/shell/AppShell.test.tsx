import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { AppShell } from "./AppShell";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubSession(roles: string[], tzCheck?: { at: string; offsetMinutes: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@example.invalid", roles }, expiresAt: new Date().toISOString() });
      }
      if (url === "/nrms/api/config") return jsonResponse(200, tzCheck ? { tzCheck } : {});
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function renderShell(roles: string[], tzCheck?: { at: string; offsetMinutes: number }) {
  stubSession(roles, tzCheck);
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/"]}>
        <AppShell />
      </MemoryRouter>
    </SessionProvider>,
  );
  await waitFor(() => expect(screen.getByText("Signed in as Pat")).toBeInTheDocument());
}

const allLabels = ["Releases", "Search", "Website", "Users", "Error log"];
const visibleLabels = () => allLabels.filter((label) => screen.queryByRole("link", { name: label }) !== null);

describe("AppShell nav — roles decide what's shown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a viewer sees Releases + Search only", async () => {
    await renderShell(["NRMS.Viewer"]);
    expect(visibleLabels()).toEqual(["Releases", "Search"]);
  });

  it("a site editor also sees Website", async () => {
    await renderShell(["NRMS.SiteEditor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website"]);
  });

  it("Core.Admin sees Website (to reach Project Blue Bridge), Users and the error log", async () => {
    await renderShell(["Core.Admin"]);
    expect(visibleLabels()).toEqual(["Website", "Users", "Error log"]);
  });
});

// Fix round 1 (3f Task 3), finding 3: a persistent warning when the browser's own tzdata
// disagrees with the server's for GET /config's tzCheck instant.
describe("AppShell — browser time-zone drift warning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows nothing when there's no tzCheck mismatch", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(420); // UTC-7, agrees
    await renderShell(["NRMS.Viewer"], { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 });
    expect(screen.queryByText(/time-zone information is out of date/i)).not.toBeInTheDocument();
  });

  it("shows a persistent warning when the browser's tzdata disagrees with the server's", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480); // stuck on UTC-8
    await renderShell(["NRMS.Viewer"], { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 });
    expect(await screen.findByText(/time-zone information is out of date/i)).toBeInTheDocument();
  });
});
