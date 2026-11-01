/** axe checks for Users and the error log (task-5-brief.md's "axe clean on every screen"). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { UsersScreen } from "./users/UsersScreen";
import { ErrorLogScreen } from "./errors/ErrorLogScreen";
import { MediaListNamesScreen } from "./media-lists/MediaListNamesScreen";
import { CalendarAccessScreen } from "./calendar-access/CalendarAccessScreen";
import { OrganizationsScreen } from "./organizations/OrganizationsScreen";
import { OrganizationEditForm } from "./organizations/OrganizationEditForm";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { CategoriesScreen } from "./categories/CategoriesScreen";
import { PageTitlesScreen } from "./page-titles/PageTitlesScreen";
import { PageTypesFixture, PAGE_IMAGES } from "./page-titles/fixtures";
import { GovernmentTermsScreen } from "./government-terms/GovernmentTermsScreen";
import { ACCESS_USERS, ORGS } from "./calendar-access/fixtures";
import type { UserView } from "./users/UsersScreen";
import { AdminHistoryScreen } from "./history/AdminHistoryScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const ONE_USER: UserView = { id: "u1", email: "pat@x.invalid", displayName: "Pat", isActive: true, signInMethod: "local", roles: ["Core.Admin"] };

describe("accessibility — Users, Media list names and error log", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("UsersScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/users") return jsonResponse(200, [ONE_USER]);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<UsersScreen />));
    await screen.findByRole("table", { name: "Staff users" });
    expect(await seriousViolations(container)).toEqual([]);
    // And with a user's editor open in its row.
    (await screen.findByRole("button", { name: "Edit pat@x.invalid" })).click();
    await screen.findByRole("heading", { name: "pat@x.invalid" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("UsersScreen, with a user's History open, and Admin history", async () => {
    const page = {
      items: [{ id: 1, at: "2026-01-15T17:00:00Z", actorId: "u1", actorName: "Pat", action: "user.roles", targetType: "user", targetId: "u1", targetLabel: "Pat", details: { added: ["Core.Admin"], removed: [] } }],
      total: 60,
      page: 1,
      pageSize: 50,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/users") return jsonResponse(200, [{ ...ONE_USER, lastSignInAt: "2026-01-15T17:00:00Z" }]);
        if (url.startsWith("/core/api/audit?")) return jsonResponse(200, page);
        if (url === "/core/api/organizations") return jsonResponse(200, []);
        return jsonResponse(200, {});
      }),
    );
    const user = userEvent.setup();
    const { container } = render(withAuth(<UsersScreen />));
    await user.click(await screen.findByRole("button", { name: "Edit pat@x.invalid" }));
    await user.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByRole("list", { name: "Changes to Pat, newest first" });
    expect(await seriousViolations(container)).toEqual([]);
    cleanup();
    const history = render(withAuth(<AdminHistoryScreen />));
    await screen.findByRole("table", { name: "Admin history, newest first" });
    expect(await seriousViolations(history.container)).toEqual([]);
  });

  it("MediaListNamesScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nrms/api/media-lists") return jsonResponse(200, [{ key: "regional", displayName: "Regional media", sortOrder: 1, isActive: true }]);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<MediaListNamesScreen />));
    await screen.findByRole("cell", { name: "regional" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("CategoriesScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/core/api/terms/sector")
          return jsonResponse(200, [{ kind: "sector", key: "health", displayName: "Health", sortOrder: 1, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-01T00:00:00.000Z" }]);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<CategoriesScreen />));
    await screen.findByRole("cell", { name: "health" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("PageTitlesScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nrms/api/page-types") return jsonResponse(200, PageTypesFixture);
        if (url === "/nrms/api/page-images") return jsonResponse(200, PAGE_IMAGES);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<PageTitlesScreen />));
    await screen.findByRole("table", { name: "Release page titles" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("ErrorLogScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/stack/errors?limit=200") return jsonResponse(200, { errors: [{ timestamp: "2026-10-05T10:00:00.000Z", message: "boom", pid: 1, startedAt: "2026-10-05T00:00:00.000Z" }] });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<ErrorLogScreen />));
    await screen.findByText("boom");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("CalendarAccessScreen, with an editor open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "self-1", name: "Sam Self", email: "sam.self@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/calendar-access") return jsonResponse(200, ACCESS_USERS);
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<CalendarAccessScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    await screen.findByRole("form", { name: "Calendar access for Robin Staff" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("OrganizationsScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS.map((o) => ({ ...o, minister: { name: "Pat Minister" } })));
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<OrganizationsScreen />));
    await screen.findByLabelText("Health is an HQ organization");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("OrganizationsScreen, with the edit form open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS.map((o) => ({ ...o, sortOrder: 1, parentKey: null, minister: { name: "Pat Minister" }, url: "https://gov.bc.ca/x", social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, topicLinks: [{ text: "Topic", url: "/topic" }], serviceLinks: [] })));
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<OrganizationsScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: `Edit ${ORGS[0]!.displayName}` }));
    await screen.findByRole("form", { name: `Edit ${ORGS[0]!.displayName}` });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("OrganizationEditForm, with the biography, Meet the Team links, media contacts and their notes and errors showing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: "invalid request",
          issues: [
            { code: "custom", path: ["minister", "detailsHtml"], message: "Keep the biography to 20,000 characters or fewer." },
            { code: "custom", path: ["secondContact", "emailAddress"], message: "Enter an email address like name@gov.bc.ca." },
            { code: "custom", path: ["weekendContactNumber"], message: "Keep phone numbers to 50 characters or fewer." },
            { code: "custom", path: ["teamLinks", 0, "url"], message: "Must start with https:// or / (a page on this site)." },
          ],
        }),
      ),
    );
    const org = {
      key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 1, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
      minister: { name: "Pat Minister", summary: null, detailsHtml: "<p>Pat grew up in Prince George.</p>", email: null, photoUrl: null, address: null },
      contact: null,
      secondContact: { fullName: "Sam Roe", phoneNumber: null, mobileNumber: null, emailAddress: null },
      weekendContactNumber: null,
      social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
      topicLinks: [], serviceLinks: [], teamLinks: [{ text: "Cabinet Ministers", url: "cabinet" }],
      sectorKeys: [], isHq: false, isPublic: true, successorKeys: [], updatedAt: "2026-10-02T16:46:05.527-07:00",
    } as OrgRecord;
    const { container } = render(<OrganizationEditForm org={org} orgs={[org]} isAdmin={false} onSaved={() => {}} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Minister name"), "x");
    await user.type(screen.getByLabelText("After-hours phone"), "1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Keep phone numbers to 50 characters or fewer.");
    expect(screen.getByText("The biography still describes the previous minister.")).toBeInTheDocument();
    expect(screen.getByText("The public page shows the alternate only with a primary contact.")).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("OrganizationsScreen, with the add and deactivate prompts open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS.map((o) => ({ ...o, sortOrder: 1, parentKey: null, minister: { name: "Pat Minister" } })));
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<OrganizationsScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `Deactivate ${ORGS[0]!.displayName}` }));
    await user.click(screen.getByRole("button", { name: "Add ministry" }));
    await user.type(screen.getByLabelText(/Ministry name/), "Citizens' Services");
    await screen.findByRole("form", { name: "Add a ministry" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("GovernmentTermsScreen, with the start and confirm step open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/government-terms")
          return jsonResponse(200, {
            today: "2026-10-27",
            terms: [
              { id: "t1", slug: "2024-onward", label: null, startDate: "2024-11-18", endDate: null, status: "current", legacyArchiveUrl: null, legacyId: null, releaseCount: 3 },
              { id: "t2", slug: "2028-onward", label: null, startDate: "2028-11-20", endDate: null, status: "scheduled", legacyArchiveUrl: null, legacyId: null, releaseCount: 0 },
              { id: "t3", slug: "old", label: "Old archive", startDate: null, endDate: null, status: "undated", legacyArchiveUrl: null, legacyId: null, releaseCount: 1 },
            ],
          });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<GovernmentTermsScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start new government term" }));
    await user.type(screen.getByLabelText(/Start date/), "2030-01-01");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("group", { name: "Confirm the new term" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("GovernmentTermsScreen, with the edit form and the delete confirm open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/government-terms")
          return jsonResponse(200, {
            today: "2026-10-27",
            terms: [
              { id: "t1", slug: "2024-onward", label: null, startDate: "2024-11-18", endDate: null, status: "current", legacyArchiveUrl: null, legacyId: null, releaseCount: 3 },
              { id: "t2", slug: "2028-onward", label: null, startDate: "2028-11-20", endDate: null, status: "scheduled", legacyArchiveUrl: null, legacyId: null, releaseCount: 0 },
            ],
          });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<GovernmentTermsScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit 2024-onward" }));
    const date = await screen.findByLabelText("Start date");
    await user.clear(date);
    await user.type(date, "2024-11-19");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("group", { name: "Confirm the new start date" });
    await user.click(screen.getByRole("button", { name: "Delete 2028-onward" }));
    await screen.findByRole("group", { name: "Delete 2028-onward" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
