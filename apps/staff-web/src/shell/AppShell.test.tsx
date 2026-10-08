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
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", ...(tzCheck ? { tzCheck } : {}) });
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

const allLabels = ["Releases", "Search", "Website", "Subscribers", "Users", "Calendar access", "Organizations", "Media list names", "Error log"];
const visibleLabels = () => allLabels.filter((label) => screen.queryByRole("link", { name: label }) !== null);

describe("AppShell nav — roles decide what's shown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  // Minors: Website opened up to every read role (Featured/the log are read-only for all of
  // them) — a Viewer now sees the nav item too, even though most of Website still isn't
  // theirs to manage.
  it("a viewer sees Releases + Search + Website (read-only Featured/log)", async () => {
    await renderShell(["NRMS.Viewer"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website"]);
  });

  it("a site editor also sees Website", async () => {
    await renderShell(["NRMS.SiteEditor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website"]);
  });

  it("Core.Admin sees Website (to reach Project Blue Bridge), Users, Media list names and the error log", async () => {
    await renderShell(["Core.Admin"]);
    expect(visibleLabels()).toEqual(["Website", "Users", "Calendar access", "Organizations", "Media list names", "Error log"]);
  });

  it("each NoD role sees Subscribers; NRMS roles don't", async () => {
    await renderShell(["NoD.Viewer"]);
    expect(visibleLabels()).toEqual(["Subscribers"]);
    cleanup();
    await renderShell(["NoD.Editor", "NRMS.Editor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website", "Subscribers"]);
  });

  it("Calendar Administrators and System Administrators see Calendar access only; other Calendar roles see nothing yet", async () => {
    await renderShell(["Calendar.Administrator"]);
    expect(visibleLabels()).toEqual(["Calendar access"]);
    cleanup();
    await renderShell(["Calendar.SysAdmin"]);
    expect(visibleLabels()).toEqual(["Calendar access"]);
    cleanup();
    await renderShell(["Calendar.Advanced"]);
    expect(visibleLabels()).toEqual([]);
  });
});

// Fix round 1 (3f Task 3), finding 3: a persistent warning when the browser's own tzdata
// disagrees with the server's for GET /config's tzCheck instant — compared *for the tenant
// zone specifically* (fix round 2, bug 2), never the device's own default zone.
describe("AppShell — browser time-zone drift warning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows nothing when there's no tzCheck mismatch (real tzdata, no device-zone mocking needed)", async () => {
    await renderShell(["NRMS.Viewer"], { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 });
    expect(screen.queryByText(/time-zone information is out of date/i)).not.toBeInTheDocument();
  });

  it("shows a persistent warning when the browser's own Intl answer for the tenant zone disagrees with the server's (stale tzdata)", async () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (this: unknown, locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      if (options?.timeZone === "America/Vancouver" && options.timeZoneName === "longOffset") {
        return { formatToParts: () => [{ type: "timeZoneName", value: "GMT-08:00" }] } as unknown as Intl.DateTimeFormat; // stuck on UTC-8
      }
      return new RealDateTimeFormat(locale, options);
    });
    await renderShell(["NRMS.Viewer"], { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 });
    expect(await screen.findByText(/time-zone information is out of date/i)).toBeInTheDocument();
  });
});
