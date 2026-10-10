import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { CalendarSection } from "./CalendarSection";
import { CalendarHome } from "./CalendarHome";
import { LookupsScreen } from "./lookups/LookupsScreen";
import { LookupScreen } from "./lookups/LookupScreen";
import { CalendarUsersScreen } from "./users/CalendarUsersScreen";
import { CalendarUserScreen } from "./users/CalendarUserScreen";
import { TransferScreen } from "./transfer/TransferScreen";
import { DeadLettersScreen } from "./dead-letters/DeadLettersScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const ME = { userId: "u1", displayName: "Pat", role: "Calendar.Administrator", level: 4, ministryKeys: ["health"], isHq: false };
const LOOKUP = { name: "event-planners", label: "Event planners", singular: "event planner", editable: true, minRole: "Calendar.Administrator", nameMax: 100, extras: [{ key: "phone", label: "Phone", max: 50 }], rows: [{ id: 1, name: "Sample Planner", sortOrder: 1, isActive: true, extras: { phone: "250-555-0101" } }] };
const USER_ROWS = [{ userId: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKey: "health", ministryAbbreviation: "HLTH", rank: 4 }];
const USER_DETAIL = {
  user: { id: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKeys: ["health"] },
  profile: { phone: "250-555-0100", mobile: null, jobTitle: null, description: null },
  commContacts: [{ ministryKey: "health", rank: 4, isActive: true }],
};
const OTHER_USER_DETAIL = {
  user: { id: "u9", displayName: "Jamie Visitor", email: "jamie.visitor@example.test", isActive: true, role: "Calendar.Editor", ministryKeys: ["health"] },
  profile: { phone: null, mobile: null, jobTitle: null, description: null },
  commContacts: [],
};
const CORE_USERS = [
  { id: "u1", email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
  { id: "u9", email: "jamie.visitor@example.test", displayName: "Jamie Visitor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
];
const ORGS = [{ key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false, isPublic: true }];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/me") return jsonResponse(200, ME);
      if (url === "/calendar/api/lookups") return jsonResponse(200, [{ ...LOOKUP, rows: undefined }]);
      if (url === "/calendar/api/lookups/event-planners") return jsonResponse(200, LOOKUP);
      if (url === "/calendar/api/users/u1") return jsonResponse(200, USER_DETAIL);
      if (url === "/calendar/api/users/u9") return jsonResponse(200, OTHER_USER_DETAIL);
      if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, [{ id: 1, userId: "u1", displayName: "Robin Staff", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: true, canReceive: true, label: "Robin Staff (HLTH)" }]);
      if (url.endsWith("/open-activities")) return jsonResponse(200, { activities: [], truncated: false });
      if (url === "/calendar/api/dead-letters") return jsonResponse(200, { items: [{ eventId: "11111111-1111-4111-8111-111111111111", subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" }], truncated: true });
      if (url.startsWith("/calendar/api/users")) return jsonResponse(200, USER_ROWS);
      if (url === "/core/api/calendar-access") return jsonResponse(200, CORE_USERS);
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      return jsonResponse(200, {});
    }),
  );
}

const at = (path: string) => (
  <SessionProvider>
    <MemoryRouter initialEntries={[path]}>
      <RequireAuth>
        <Routes>
          <Route path="/calendar" element={<CalendarSection />}>
            <Route index element={<CalendarHome />} />
            <Route path="lookups" element={<LookupsScreen />} />
            <Route path="lookups/:name" element={<LookupScreen />} />
            <Route path="users" element={<CalendarUsersScreen />} />
            <Route path="users/:id" element={<CalendarUserScreen />} />
            <Route path="transfer" element={<TransferScreen />} />
            <Route path="dead-letters" element={<DeadLettersScreen />} />
          </Route>
        </Routes>
      </RequireAuth>
    </MemoryRouter>
  </SessionProvider>
);

describe("accessibility: Calendar section", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("Calendar home", async () => {
    stub();
    const { container } = render(at("/calendar"));
    await screen.findByRole("heading", { level: 1, name: "Corporate Calendar" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("lookup list", async () => {
    stub();
    const { container } = render(at("/calendar/lookups"));
    await screen.findByRole("link", { name: "Event planners" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("one lookup, with its extra fields", async () => {
    stub();
    const { container } = render(at("/calendar/lookups/event-planners"));
    await screen.findByText("Sample Planner");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the no-access message when the projection refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/me") return jsonResponse(403, { error: "no Calendar access" });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(at("/calendar"));
    expect(await screen.findByText("You don’t have Calendar access. Ask a Calendar administrator.")).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Calendar users", async () => {
    stub();
    const { container } = render(at("/calendar/users"));
    await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("one Calendar user", async () => {
    stub();
    const { container } = render(at("/calendar/users/u1"));
    await screen.findByRole("form", { name: "Contact details" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Transfer", async () => {
    stub();
    const { container } = render(at("/calendar/transfer"));
    await screen.findByRole("heading", { level: 1, name: "Transfer activities" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Undelivered events", async () => {
    stub();
    const { container } = render(at("/calendar/dead-letters"));
    await screen.findByRole("heading", { level: 1, name: "Undelivered events" });
    await screen.findByText("Only the 200 most recent are listed.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the deactivation preview", async () => {
    stub();
    const { container } = render(at("/calendar/users/u9"));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deactivate Jamie Visitor" }));
    await screen.findByRole("region", { name: "Before deactivating Jamie Visitor" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
