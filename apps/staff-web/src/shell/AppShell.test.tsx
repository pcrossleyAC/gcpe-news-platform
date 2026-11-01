import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { dateTimeText } from "../screens/calendar/list/dates";
import { playOldRulesBrowser } from "../format/oldRulesBrowser.testkit";
import { SessionProvider } from "../session/SessionContext";
import { AppShell } from "./AppShell";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubSession(roles: string[], tzCheck?: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@example.invalid", roles }, expiresAt: new Date().toISOString() });
      }
      if (url === "/core/api/time-zone-check") return jsonResponse(200, { timeZone: "America/Vancouver", ...(tzCheck ? { tzCheck } : {}) });
      if (url === "/nrms/api/config" && !roles.some((r) => r.startsWith("NRMS.") || r === "Core.Admin")) return jsonResponse(403, { error: "forbidden" });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function renderShell(roles: string[], tzCheck?: object) {
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

const allLabels = ["Releases", "Search", "Website", "Subscribers", "Calendar", "Users", "Calendar access", "Organizations", "Government terms", "Sectors, themes and tags", "Release page titles", "Media list names", "Error log"];
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
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website", "Organizations"]);
  });

  it("Core.Admin sees 'Sectors, themes and tags'; NRMS.SiteEditor does not", async () => {
    await renderShell(["Core.Admin"]);
    expect(screen.getByRole("link", { name: "Sectors, themes and tags" })).toHaveAttribute("href", "/categories");
    cleanup();
    await renderShell(["NRMS.SiteEditor"]);
    expect(screen.queryByRole("link", { name: "Sectors, themes and tags" })).toBeNull();
  });

  it("Core.Admin sees 'Release page titles'; NRMS.SiteEditor does not", async () => {
    await renderShell(["Core.Admin"]);
    expect(screen.getByRole("link", { name: "Release page titles" })).toHaveAttribute("href", "/release-page-titles");
    cleanup();
    await renderShell(["NRMS.SiteEditor"]);
    expect(screen.queryByRole("link", { name: "Release page titles" })).toBeNull();
  });

  it("shows Organizations in the nav for NRMS.SiteEditor", async () => {
    await renderShell(["NRMS.SiteEditor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website", "Organizations"]);
  });

  it("Core.Admin sees Website (to reach Project Blue Bridge), Users, Media list names and the error log", async () => {
    await renderShell(["Core.Admin"]);
    expect(visibleLabels()).toEqual(["Website", "Users", "Calendar access", "Organizations", "Government terms", "Sectors, themes and tags", "Release page titles", "Media list names", "Error log"]);
  });

  it("each NoD role sees Subscribers; NRMS roles don't", async () => {
    await renderShell(["NoD.Viewer"]);
    expect(visibleLabels()).toEqual(["Subscribers"]);
    cleanup();
    await renderShell(["NoD.Editor", "NRMS.Editor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website", "Subscribers"]);
  });

  it("Calendar Administrators and System Administrators also see Calendar access; other Calendar roles don't", async () => {
    await renderShell(["Calendar.Administrator"]);
    expect(visibleLabels()).toEqual(["Calendar", "Calendar access"]);
    cleanup();
    await renderShell(["Calendar.SysAdmin"]);
    expect(visibleLabels()).toEqual(["Calendar", "Calendar access"]);
    cleanup();
    await renderShell(["Calendar.Advanced"]);
    expect(visibleLabels()).toEqual(["Calendar"]);
  });

  it("shows Calendar to any Calendar role, and only to them", async () => {
    await renderShell(["Calendar.ReadOnly"]);
    expect(visibleLabels()).toEqual(["Calendar"]);
  });
});

describe("AppShell header", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows who is signed in, and Sign out, in the header bar rather than the page", async () => {
    await renderShell(["NRMS.Viewer"]);
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Signed in as Pat")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("links to Help from the header, for every signed-in user", async () => {
    for (const roles of [["NRMS.Viewer"], ["NoD.Viewer"], ["Calendar.ReadOnly"], []]) {
      await renderShell(roles);
      expect(within(screen.getByRole("banner")).getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help");
      cleanup();
    }
  });
});

// A persistent notice when the browser's own tzdata disagrees with the server's for the
// tzCheck instant — compared *for the tenant zone specifically*, never the device's own zone.
// Owner decision 2026-10-31: when the server says since when BC's offset is fixed, the Hub
// corrects the times itself, and the screen waits for the check so no wrong time is ever shown.
const BC_CHECK = { at: "2026-12-15T20:00:00Z", offsetMinutes: -420, fixedSince: "2026-03-08T10:00:00.000Z" };

function TimeProbe(): React.JSX.Element {
  return <p data-testid="probe">{dateTimeText("2026-11-03T16:00:00Z", "America/Vancouver")}</p>;
}

async function renderShellWithScreen(roles: string[], tzCheck: object) {
  stubSession(roles, tzCheck);
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const t = document.querySelector('[data-testid="probe"]')?.textContent;
    if (t) seen.push(t);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<TimeProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("probe")).toBeInTheDocument());
  observer.disconnect();
  return seen;
}

describe("AppShell — browser time-zone drift", () => {
  let undo: (() => void) | null = null;
  afterEach(() => {
    undo?.();
    undo = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("an up-to-date browser: no notice, and the screen's times as the browser has them", async () => {
    const seen = await renderShellWithScreen(["NRMS.Viewer"], BC_CHECK);
    expect(screen.queryByText(/time-zone information is out of date/i)).not.toBeInTheDocument();
    expect(seen.every((t) => t === "Nov 3, 2026 9:00 AM")).toBe(true);
  });

  it("an old-rules browser: the screen's times are corrected from the first paint, and the notice says so", async () => {
    undo = playOldRulesBrowser();
    const seen = await renderShellWithScreen(["NRMS.Viewer"], BC_CHECK);
    expect(screen.getByTestId("probe")).toHaveTextContent("Nov 3, 2026 9:00 AM");
    expect(seen.filter((t) => t !== "Nov 3, 2026 9:00 AM")).toEqual([]);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Update your browser");
    expect(notice).toHaveTextContent("The times shown here have been corrected for BC time, but other websites and apps may show times an hour off. Update your browser when you can.");
    expect(within(notice).queryByRole("button")).toBeNull(); // not closeable
    // Staff with no NRMS role (NRMS's /config refuses them) are covered too.
    cleanup();
    await renderShellWithScreen(["NoD.Viewer"], BC_CHECK);
    expect(screen.getByTestId("probe")).toHaveTextContent("Nov 3, 2026 9:00 AM");
    expect(screen.getByText(/have been corrected for BC time/)).toBeInTheDocument();
  });

  it("an old-rules browser and nothing to correct with: the old warning", async () => {
    undo = playOldRulesBrowser();
    await renderShellWithScreen(["NRMS.Viewer"], { ...BC_CHECK, fixedSince: null });
    expect(await screen.findByText("Your browser's time-zone information is out of date, so times shown here may be off by an hour. Update your browser.")).toBeInTheDocument();
  });
});

describe("AppShell navigation structure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("groups the sections under Work and Administration, leaving out a group with nothing in it", async () => {
    await renderShell(["NRMS.SiteEditor"]);
    const work = screen.getByRole("list", { name: "Work" });
    expect(within(work).getAllByRole("link").map((l) => l.textContent)).toEqual(["Releases", "Search", "Website"]);
    const admin = screen.getByRole("list", { name: "Administration" });
    expect(within(admin).getAllByRole("link").map((l) => l.textContent)).toEqual(["Organizations"]);
    cleanup();
    await renderShell(["NoD.Viewer"]);
    expect(screen.queryByRole("list", { name: "Administration" })).toBeNull();
  });

  it("offers a skip link to the main content, and a Menu button that says whether the menu is open", async () => {
    await renderShell(["NRMS.Viewer"]);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(menu.getAttribute("aria-controls")!)).toContainElement(screen.getByRole("link", { name: "Releases" }));
  });

  it("closes the menu when any link in it is followed, the current page's own included", async () => {
    await renderShell(["NRMS.Viewer"]);
    const menu = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("link", { name: "Search" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    // The current page: following it changes no path, and still closes the menu.
    fireEvent.click(screen.getByRole("link", { name: "Search" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the menu on Escape and puts focus back on the Menu button", async () => {
    await renderShell(["NRMS.Viewer"]);
    const menu = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    const link = screen.getByRole("link", { name: "Releases" });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
  });
});
