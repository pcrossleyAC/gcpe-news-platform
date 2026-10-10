import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarUserScreen } from "./CalendarUserScreen";
import type { CalendarUserDetail, OpenActivities } from "./types";

const DETAIL: CalendarUserDetail = {
  user: { id: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKeys: ["health"] },
  profile: { phone: "250-555-0100", mobile: null, jobTitle: null, description: null },
  commContacts: [{ ministryKey: "health", rank: 4, isActive: true }],
};
let openActivities: OpenActivities = { activities: [], truncated: false };
const CORE_USERS = [
  { id: "a1", email: "pat@x.invalid", displayName: "Pat", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] },
  { id: "u1", email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
  { id: "u2", email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
  { id: "u3", email: "dale.dormant@example.test", displayName: "Dale Dormant", isActive: false, calendarRole: null, organizationKeys: [] },
];
const ORGS = [{ key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false, isPublic: true }];

function stub(calls: { url: string; init?: RequestInit }[], detail = DETAIL, override?: (url: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const o = override?.(url, init);
      if (o) return o;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === `/calendar/api/users/${detail.user.id}` && (init?.method ?? "GET") === "GET") return jsonResponse(200, detail);
      if (url === "/core/api/calendar-access") return jsonResponse(200, CORE_USERS);
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (url.endsWith("/profile")) return jsonResponse(200, JSON.parse(init!.body as string));
      if (url.includes("/comm-contacts/")) return jsonResponse(200, [{ ministryKey: "health", rank: JSON.parse(init!.body as string).rank, isActive: true }]);
      if (url.endsWith("/active")) return jsonResponse(200, { ...CORE_USERS[1], isActive: JSON.parse(init!.body as string).isActive });
      if (url.endsWith("/link")) return jsonResponse(200, { ...CORE_USERS[2], email: "kim.imported@example.test", isActive: true });
      if (url.endsWith("/open-activities")) return jsonResponse(200, openActivities);
      if (url.startsWith("/calendar/api/users/")) return jsonResponse(404, { error: "not found" });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderAt = (id: string) =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[`/calendar/users/${id}`]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/users/:id" element={<CalendarUserScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("CalendarUserScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    openActivities = { activities: [], truncated: false };
  });

  it("shows the user and saves contact details", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    await waitFor(() => expect(document.title).toBe("Robin Staff — GCPE News Staff"));
    const form = await screen.findByRole("form", { name: "Contact details" });
    const job = within(form).getByLabelText("Job title");
    const user = userEvent.setup();
    await user.type(job, "Sample title");
    await user.click(within(form).getByRole("button", { name: "Save contact details" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/users/u1/profile")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/profile"))!.init!.body as string)).toEqual({ phone: "250-555-0100", mobile: "", jobTitle: "Sample title", description: "" });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved contact details.");
  });

  it("shows the server's field message", async () => {
    stub([], DETAIL, (url, init) =>
      url.endsWith("/profile") && init?.method === "PUT" ? jsonResponse(400, { error: "invalid request", issues: [{ message: "use 12 digits and hyphens, like 250-555-0100", path: ["phone"] }] }) : undefined,
    );
    renderAt("u1");
    const form = await screen.findByRole("form", { name: "Contact details" });
    await userEvent.setup().click(within(form).getByRole("button", { name: "Save contact details" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("use 12 digits and hyphens, like 250-555-0100");
  });

  it("sets a comm-contact rank per ministry", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const rank = await screen.findByLabelText("Comm contact rank for Health (HLTH)");
    expect(rank).toHaveValue("4");
    await userEvent.setup().selectOptions(rank, "1");
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/users/u1/comm-contacts/health")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.includes("/comm-contacts/"))!.init!.body as string)).toEqual({ rank: 1 });
  });

  it("deactivates through Core's Calendar route", async () => {
    openActivities = { activities: [], truncated: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    await user.click(within(preview).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/calendar-access/u1/active")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/active"))!.init!.body as string)).toEqual({ isActive: false });
    expect(await screen.findByRole("status")).toHaveTextContent("Robin Staff is deactivated. The Calendar picks this up within a minute.");
  });

  it("lists the user's open activities before deactivating, with a way to Transfer them", async () => {
    openActivities = { activities: [{ id: 41, reference: "HLTH-41", title: "Sample launch", startAt: "2026-11-10T17:00:00.000Z", endAt: null, startDate: "2026-11-10", endDate: null }], truncated: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    expect(within(preview).getByText("HLTH-41 — Sample launch — 2026-11-10")).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "Transfer their activities first" })).toHaveAttribute("href", "/calendar/transfer");
    expect(calls.some((c) => c.url.endsWith("/active"))).toBe(false);
    await user.click(within(preview).getByRole("button", { name: "Deactivate anyway" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/active"))).toBe(true));
  });

  it("deactivates a user with no open activities after saying so; Cancel deactivates nobody", async () => {
    openActivities = { activities: [], truncated: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    expect(within(preview).getByText("No open activities.")).toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Before deactivating Robin Staff" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Deactivate Robin Staff" }));
    await user.click(within(await screen.findByRole("region", { name: "Before deactivating Robin Staff" })).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/active"))).toHaveLength(1));
  });

  it("offers Link for an inactive user with no email", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const imported = { ...DETAIL, user: { ...DETAIL.user, id: "u2", displayName: "Kim Imported", email: null, isActive: false }, profile: { phone: null, mobile: null, jobTitle: null, description: null }, commContacts: [] };
    stub(calls, imported);
    renderAt("u2");
    const form = await screen.findByRole("form", { name: "Link and activate Kim Imported" });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText("Email"), "kim.imported@example.test");
    await user.click(within(form).getByRole("button", { name: "Link and activate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/calendar-access/u2/link")).toBe(true));
  });

  it("shows Core's refusal for a user with other roles", async () => {
    openActivities = { activities: [], truncated: false };
    stub([], DETAIL, (url) => (url.endsWith("/active") ? jsonResponse(403, { error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" }) : undefined));
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    await user.click(within(preview).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only a Core admin can change a user who also has NRMS or NoD roles");
  });

  it.each([
    [403, "Administrators see a user's open activities"],
    [404, "not found"],
  ])("shows the refusal when the open activities fail (%i), and deactivates nobody", async (status, error) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls, DETAIL, (url) => (url.endsWith("/open-activities") ? jsonResponse(status, { error }) : undefined));
    renderAt("u1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(screen.queryByRole("region", { name: "Before deactivating Robin Staff" })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/active"))).toBe(false);
    expect(screen.getByRole("button", { name: "Deactivate Robin Staff" })).toBeInTheDocument();
  });

  it("shows Core's refusal after a preview listing open activities, and the user stays active", async () => {
    openActivities = { activities: [{ id: 41, reference: "HLTH-41", title: "Sample launch", startAt: "2026-11-10T17:00:00.000Z", endAt: null, startDate: "2026-11-10", endDate: null }], truncated: false };
    stub([], DETAIL, (url) => (url.endsWith("/active") ? jsonResponse(403, { error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" }) : undefined));
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    await user.click(within(preview).getByRole("button", { name: "Deactivate anyway" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only a Core admin can change a user who also has NRMS or NoD roles");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Deactivate Robin Staff" })).toBeInTheDocument();
  });

  it("an unknown user is not found", async () => {
    stub([]);
    renderAt("nobody");
    expect(await screen.findByText("This user isn’t in the Calendar.")).toBeInTheDocument();
  });

  it("shows each contact field's own hint, and accepts free-text phone input", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const form = await screen.findByRole("form", { name: "Contact details" });
    expect(within(form).getByText("Up to 20 characters")).toBeInTheDocument();
    expect(within(form).getByText("12 digits and hyphens, like 250-555-0100")).toBeInTheDocument();
    const user = userEvent.setup();
    const phone = within(form).getByLabelText("Phone");
    await user.clear(phone);
    await user.type(phone, "250-387-1234 x22");
    await user.click(within(form).getByRole("button", { name: "Save contact details" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/users/u1/profile")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/profile"))!.init!.body as string).phone).toBe("250-387-1234 x22");
  });

  it("matches the Core user by canonical id, even in a different case", async () => {
    const upperCore = CORE_USERS.map((c) => (c.id === "u1" ? { ...c, id: "U1", isActive: false } : c));
    stub([], DETAIL, (url) => (url === "/core/api/calendar-access" ? jsonResponse(200, upperCore) : undefined));
    renderAt("u1");
    await screen.findByRole("heading", { level: 1, name: "Robin Staff" });
    expect(await screen.findByRole("button", { name: "Reactivate Robin Staff" })).toBeInTheDocument();
  });

  it("locks Calendar access editing for the actor's own row", async () => {
    const self: CalendarUserDetail = { ...DETAIL, user: { ...DETAIL.user, id: "a1", displayName: "Pat" } };
    stub([], self);
    renderAt("a1");
    await screen.findByRole("heading", { level: 1, name: "Pat" });
    expect(screen.getByText("You can’t change your own Calendar access.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Calendar access for Pat" })).toBeNull();
  });

  it("offers the editor for a target the actor may change", async () => {
    stub([]);
    renderAt("u1");
    expect(await screen.findByRole("button", { name: "Edit Calendar access for Robin Staff" })).toBeInTheDocument();
  });

  it("doesn't offer an Administrator a grant to an inactive user with no Calendar role", async () => {
    const dormant: CalendarUserDetail = { ...DETAIL, user: { ...DETAIL.user, id: "u3", displayName: "Dale Dormant", email: "dale.dormant@example.test", isActive: false, role: null, ministryKeys: [] }, commContacts: [] };
    stub([], dormant);
    renderAt("u3");
    await screen.findByRole("heading", { level: 1, name: "Dale Dormant" });
    expect(screen.getByText("Only a Core admin can give Calendar access to an inactive user who has none.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Calendar access for Dale Dormant" })).toBeNull();
  });

  it("offers no Deactivate on the admin's own page, whatever case the id is in", async () => {
    const self: CalendarUserDetail = { ...DETAIL, user: { ...DETAIL.user, id: "A1", displayName: "Pat" } };
    stub([], self);
    renderAt("A1");
    await screen.findByRole("heading", { level: 1, name: "Pat" });
    expect(screen.queryByRole("button", { name: "Deactivate Pat" })).toBeNull();
  });
});
