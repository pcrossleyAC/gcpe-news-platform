import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { jsonResponse } from "../../../test/jsonResponse";
import { HQ_ADMIN_CONFIG, ME, renderList, stubFetch, type Call } from "./list/fixtures";

const session = (roles: string[]) => () =>
  jsonResponse(200, { user: { id: "u9", name: "Sample Admin", email: "admin@example.test", roles }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

// Owner decision 2026-10-29: an administrator who reaches /hub/calendar with nothing to show is
// pointed at Calendar access instead of a dead end.
describe("the Calendar with nothing to show", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("no Calendar access: an administrator gets a link to Calendar access", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      other: (url) =>
        url === "/core/auth/session"
          ? session(["Core.Admin"])()
          : url === "/calendar/api/me"
            ? jsonResponse(403, { error: "no Calendar access" })
            : undefined,
    });
    renderList();
    expect(await screen.findByText(/You don.t have Calendar access\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Calendar access" })).toHaveAttribute("href", "/calendar-access");
  });

  it("no Calendar access: anyone else is told to ask, with no link", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/me" ? jsonResponse(403, { error: "no Calendar access" }) : undefined) });
    renderList();
    expect(await screen.findByText("You don’t have Calendar access. Ask a Calendar administrator.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Calendar access" })).toBeNull();
  });

  const noMinistries = (roles: string[]) =>
    stubFetch([], {
      me: { ...ME, role: "Calendar.Administrator", level: 4, ministryKeys: [], isHq: false },
      config: HQ_ADMIN_CONFIG,
      page: () => ({ rows: [], total: 0, offset: 0 }),
      other: (url) => (url === "/core/auth/session" ? session(roles)() : undefined),
    });

  // A Calendar administrator can't change their own Calendar access, so a link there would be a dead end.
  it.each([["Calendar.Administrator"], ["Calendar.SysAdmin"]])("no ministries: a %s is told who can add their ministry, with no link", async (role) => {
    noMinistries([role]);
    renderList();
    expect(await screen.findByText("You aren’t in any ministry yet, so there are no activities to show you. Ask another Calendar administrator or a Core administrator to add your ministry.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Calendar access" })).toBeNull();
  });

  it("no ministries: a Core administrator, who can change their own access, gets the link", async () => {
    noMinistries(["Core.Admin"]);
    renderList();
    expect(await screen.findByText(/You aren.t in any ministry yet, so there are no activities to show you\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Calendar access" })).toHaveAttribute("href", "/calendar-access");
  });

  it("a ministry member sees no such note", async () => {
    stubFetch([]);
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.queryByText(/You aren.t in any ministry/)).toBeNull();
  });
});
