import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarAccessScreen } from "./CalendarAccessScreen";
import { ACCESS_USERS, ORGS, STAFF } from "./fixtures";

type Call = { url: string; init?: RequestInit };
function stub(roles: string[], calls: Call[], onPut?: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "self-1", name: "Sam Self", email: "sam.self@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/calendar-access" && (init?.method ?? "GET") === "GET") return jsonResponse(200, ACCESS_USERS);
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
    expect(within(form).getByLabelText("GCPE Headquarters (GCPEHQ) — HQ")).toBeInTheDocument();
    await user.selectOptions(select, "Calendar.Editor");
    await user.click(within(form).getByLabelText("Health (HLTH)"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toBe("/core/api/calendar-access/staff-1");
    expect(JSON.parse(put.init!.body as string)).toEqual({ role: "Calendar.Editor", organizationKeys: ["health"] });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Calendar access for Robin Staff.");
  });

  it("shows the server's refusal inside the form", async () => {
    stub(["Calendar.Administrator"], [], () => jsonResponse(403, { error: "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry", reason: "hq-organization" }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    await user.click(within(form).getByLabelText("GCPE Headquarters (GCPEHQ) — HQ"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry");
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
});
