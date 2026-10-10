import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarAccessScreen } from "./CalendarAccessScreen";
import { ACCESS_USERS, ORGS, SELF, STAFF } from "./fixtures";
import { visibleText } from "../../../../test/visibleText";

type Call = { url: string; init?: RequestInit };
function stub(roles: string[], calls: Call[], onPut?: (url: string, init: RequestInit) => Response, opts: { users?: typeof ACCESS_USERS; sessionId?: string } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: opts.sessionId ?? "self-1", name: "Sam Self", email: "sam.self@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/calendar-access" && (init?.method ?? "GET") === "GET") return jsonResponse(200, opts.users ?? ACCESS_USERS);
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (init?.method === "PUT" && onPut) return onPut(url, init);
      throw new Error(`unhandled: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

function renderScreen() {
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <CalendarAccessScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("CalendarAccessScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("sets the document title", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    await screen.findByRole("heading", { level: 1, name: "Calendar access" });
    await waitFor(() => expect(document.title).toBe("Calendar access — GCPE News Staff"));
  });

  it("lists staff in a table, one row each, with a short Edit button that still names the user", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const edit = await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    expect(visibleText(edit)).toBe("Edit");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Email", "Calendar role", "Ministries", "Actions"]);
    expect(within(edit.closest("tr")!).getByRole("rowheader", { name: "Robin Staff" })).toBeInTheDocument();
  });

  it("an Administrator is offered roles up to Administrator, and saves the role with the ministries", async () => {
    const calls: Call[] = [];
    stub(["Calendar.Administrator"], calls, () => jsonResponse(200, { ...STAFF, calendarRole: "Calendar.Editor", organizationKeys: ["health"] }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    const select = within(form).getByLabelText("Calendar role") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["No Calendar access", "Read Only", "Editor", "Advanced", "Administrator"]);
    // Inactive ministries are offered only to users who already hold them.
    expect(within(form).queryByLabelText(/Retired Ministry/)).toBeNull();
    await user.selectOptions(select, "Calendar.Editor");
    await user.click(within(form).getByLabelText("Health (HLTH)"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toBe("/core/api/calendar-access/staff-1");
    expect(JSON.parse(put.init!.body as string)).toEqual({ role: "Calendar.Editor", organizationKeys: ["health"] });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Calendar access for Robin Staff.");
  });

  it("a non-HQ Administrator gets no Edit button on a user with an HQ ministry, and is not offered HQ ministries", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    expect(screen.queryByRole("button", { name: "Edit access for Pat Hq" })).toBeNull();
    expect(screen.getByText("Only an HQ Administrator, a System Administrator or a Core admin can change this user’s access.")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    expect(within(form).getByLabelText("Health (HLTH)")).toBeInTheDocument();
    expect(within(form).queryByLabelText(/GCPE Headquarters/)).toBeNull();
  });

  it("an HQ Administrator can edit a user with an HQ ministry and is offered HQ ministries", async () => {
    const hqSelf = { ...SELF, organizationKeys: ["gcpe-headquarters"] };
    stub(["Calendar.Administrator"], [], undefined, { users: ACCESS_USERS.map((u) => (u.id === SELF.id ? hqSelf : u)) });
    renderScreen();
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "Edit access for Pat Hq" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit access for Robin Staff" }));
    expect(within(screen.getByRole("form", { name: "Calendar access for Robin Staff" })).getByLabelText("GCPE Headquarters (GCPEHQ) — HQ")).toBeInTheDocument();
  });

  it("finds the actor's own row by canonical id: trimmed and in any case", async () => {
    const hqSelf = { ...SELF, organizationKeys: ["gcpe-headquarters"] };
    stub(["Calendar.Administrator"], [], undefined, { users: ACCESS_USERS.map((u) => (u.id === SELF.id ? hqSelf : u)), sessionId: " SELF-1 " });
    renderScreen();
    expect(await screen.findByRole("button", { name: "Edit access for Pat Hq" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit access for Sam Self" })).toBeNull();
    expect(screen.getByText("You can’t change your own Calendar access.")).toBeInTheDocument();
  });

  it("still shows the server's hq-target refusal inside the form when the screen allowed the edit", async () => {
    const copy = "only an HQ Administrator, a System Administrator or a Core admin can change the Calendar access of someone with an HQ ministry";
    stub(["Calendar.Administrator"], [], () => jsonResponse(403, { error: copy, reason: "hq-target" }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(copy);
  });

  it("names the ministries the server refused, only from those submitted", async () => {
    stub(["Calendar.Administrator"], [], () => jsonResponse(400, { error: "unknown or inactive ministry", keys: ["health", "not-submitted"] }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    await user.click(within(form).getByLabelText("Health (HLTH)"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("unknown or inactive ministry: health");
    expect(alert).not.toHaveTextContent("not-submitted");
  });

  it("a System Administrator's row and your own row are read-only for an Administrator", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    expect(screen.queryByRole("button", { name: "Edit access for Lee Sys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit access for Sam Self" })).toBeNull();
    expect(screen.getByText("Only a System Administrator or a Core admin can change this user’s access.")).toBeInTheDocument();
    expect(screen.getByText("You can’t change your own Calendar access.")).toBeInTheDocument();
  });

  it("a Core admin gets System Administrator and can edit their own row", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Sam Self" }));
    const select = within(screen.getByRole("form", { name: "Calendar access for Sam Self" })).getByLabelText("Calendar role") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toContain("System Administrator");
  });

  it("inactive users, including those with no email, appear under the filter; their inactive ministries stay offered", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    expect(screen.queryByText("Kim Imported")).toBeNull();
    await user.click(screen.getByLabelText("Show inactive users, including those with no email"));
    expect(screen.getByText("No email — inactive")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit access for Kim Imported" }));
    expect(within(screen.getByRole("form", { name: "Calendar access for Kim Imported" })).getByLabelText("Retired Ministry (RET) — inactive")).toBeChecked();
  });

  it("finds users by name or email", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    await user.type(screen.getByLabelText("Find a user by name or email"), "LEE.SYS");
    expect(screen.queryByText("Robin Staff")).toBeNull();
    expect(screen.getByText("Lee Sys")).toBeInTheDocument();
  });

  it("someone without an admin role sees the permission message and nothing is fetched", async () => {
    const calls: Call[] = [];
    stub(["Calendar.Advanced"], calls);
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/core/auth/session"]);
  });

  it("only a Core admin is offered a grant to an inactive user with no Calendar role; an active one stays open", async () => {
    const dormant = { id: "dormant-1", email: "dale.dormant@x.invalid", displayName: "Dale Dormant", isActive: false, calendarRole: null, organizationKeys: [] };
    stub(["Calendar.Administrator"], [], undefined, { users: [...ACCESS_USERS, dormant] });
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    await user.click(screen.getByLabelText("Show inactive users, including those with no email"));
    const item = screen.getByRole("rowheader", { name: "Dale Dormant" }).closest("tr")!;
    expect(within(item).getByText("Only a Core admin can give Calendar access to an inactive user who has none.")).toBeInTheDocument();
    expect(within(item).queryByRole("button")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();

    stub(["Core.Admin"], [], undefined, { users: [...ACCESS_USERS, dormant] });
    renderScreen();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    await user.click(screen.getByLabelText("Show inactive users, including those with no email"));
    expect(screen.getByRole("button", { name: "Edit access for Dale Dormant" })).toBeInTheDocument();
  });
});
