import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import type { SettingsState } from "./api";
import { MediaContactsScreen } from "./MediaContactsScreen";

const BASE: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});

const PAGE: SiteSettings["contactsPage"] = {
  heading: "Government Communications and Public Engagement",
  lineHeading: "24 hours Media Relations Contact Line",
  introHtml: "<p>Call media relations.</p>",
  listHeading: "Contact List for Media",
  contacts: [
    { group: "Office of the Premier", groupUrl: "/ministries/office-of-the-premier/", subgroup: "Premier", name: "Media Line", phone: "", cell: "", email: "Premier.Media@gov.bc.ca", placement: "bottom" },
    { group: "Communications Office", groupUrl: "", subgroup: "", name: "News Desk", phone: "250 555 0100", cell: "", email: "news@gov.bc.ca", placement: "top" },
    { group: "Service BC", groupUrl: "", subgroup: "", name: "Help Line", phone: "", cell: "", email: "", placement: "bottom" },
  ],
};
const DOC: SiteSettings = { ...BASE, contactsPage: PAGE };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(roles: string[], initial: SettingsState) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url === "/nrms/api/site/settings" && call.method === "GET") return jsonResponse(200, initial);
      if (url === "/nrms/api/site/settings/publish" && call.method === "POST") return jsonResponse(200, { revision: 5, state: initial });
      throw new Error(`unhandled: ${call.method} ${url}`);
    }),
  );
  return calls;
}

/** Like {@link stub}, but publish answers 422 with `fieldErrors` and the reload after it returns `saved`. */
function stubInvalidPublish(initial: SettingsState, saved: SettingsState, fieldErrors: SettingsState["errors"]) {
  const calls: Call[] = [];
  let gets = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url === "/nrms/api/site/settings" && call.method === "GET") return jsonResponse(200, gets++ === 0 ? initial : saved);
      if (url === "/nrms/api/site/settings/publish") return jsonResponse(422, { errors: fieldErrors.map((e) => `${e.field}: ${e.message}`), fieldErrors });
      throw new Error(`unhandled: ${call.method} ${url}`);
    }),
  );
  return calls;
}

const stateOf = (document: SiteSettings, errors: SettingsState["errors"] = []): SettingsState => ({
  live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null },
  document,
  draft: null,
  baseRevision: 4,
  errors,
});

function renderScreen() {
  return render(
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>
            <MediaContactsScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("MediaContactsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("loads the published contactsPage and shows the three BC rows with their placement", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Media contacts page", level: 1 });
    expect(await screen.findByLabelText("Page heading")).toHaveValue(PAGE.heading);
    expect(screen.getByLabelText("Contact line heading")).toHaveValue(PAGE.lineHeading);
    expect(screen.getByLabelText("List heading")).toHaveValue(PAGE.listHeading);
    expect(screen.getByText("Include the 24-hour media line number here.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Introduction" })).toHaveTextContent("Call media relations.");
    const placements = [1, 2, 3].map((n) => {
      const row = screen.getByRole("group", { name: `Contact ${n}` });
      return [within(row).getByLabelText("Name"), within(row).getByRole("radio", { name: "Above the ministries" })] as const;
    });
    expect(placements.map(([name]) => (name as HTMLInputElement).value)).toEqual(["Media Line", "News Desk", "Help Line"]);
    expect(placements.map(([, above]) => (above as HTMLInputElement).checked)).toEqual([false, true, false]);
    await waitFor(() => expect(document.title).toBe("Media contacts page — GCPE News Staff"));
  });

  it("adds, edits, moves and removes a contact; Save sends the whole contactsPage section", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Page heading");
    await user.click(screen.getByRole("button", { name: "Add contact" }));
    const added = screen.getByRole("group", { name: "Contact 4" });
    await user.type(within(added).getByLabelText("Group"), "Health");
    await user.type(within(added).getByLabelText("Name"), "Ann");
    await user.click(screen.getByRole("button", { name: "Move contact 4 up" }));
    await user.click(screen.getByRole("button", { name: "Remove contact 1" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    expect(post.body).toEqual({
      baseRevision: 4,
      section: "contactsPage",
      value: {
        ...PAGE,
        contacts: [
          PAGE.contacts[1],
          { group: "Health", groupUrl: "", subgroup: "", name: "Ann", phone: "", cell: "", email: "", placement: "top" },
          PAGE.contacts[2],
        ],
      },
    });
  });

  it("a server error on contactsPage.contacts[1].email shows beside row 2's Email", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "contactsPage.contacts[1].email", message: "Enter an email address like name@gov.bc.ca." }]));
    renderScreen();
    const row = await screen.findByRole("group", { name: "Contact 2" });
    expect(within(row).getByText("Enter an email address like name@gov.bc.ca.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Contact 1" })).queryByText(/Enter an email/)).toBeNull();
  });

  it("with a blank row dropped before sending, a server error lands on the row it was about", async () => {
    // The sent list is PAGE.contacts (the blank row left out), so contacts[1] is "News Desk".
    const error = { field: "contactsPage.contacts[1].email", message: "Enter an email address like name@gov.bc.ca." };
    const calls = stubInvalidPublish(stateOf(DOC), { ...stateOf(DOC), draft: { baseRevision: 4, updatedAt: "2026-10-28T17:00:00.000Z" } }, [error]);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Page heading");
    await user.click(screen.getByRole("button", { name: "Add contact" }));
    for (const n of [4, 3, 2]) await user.click(screen.getByRole("button", { name: `Move contact ${n} up` }));
    expect((within(screen.getByRole("group", { name: "Contact 1" })).getByLabelText("Name") as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const sent = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { value: SiteSettings["contactsPage"] };
    expect(sent.value.contacts).toEqual(PAGE.contacts);
    // The form now shows what was saved (no blank row), so row 2 is News Desk and carries the error.
    const row = await screen.findByRole("group", { name: "Contact 2" });
    expect(await within(row).findByText(error.message)).toBeInTheDocument();
    expect((within(row).getByLabelText("Name") as HTMLInputElement).value).toBe("News Desk");
    expect(screen.queryByRole("group", { name: "Contact 4" })).toBeNull();
  });

  it("a row-level server error with no field name shows on that row", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "contactsPage.contacts[2]", message: "This contact is listed twice." }]));
    renderScreen();
    const row = await screen.findByRole("group", { name: "Contact 3" });
    expect(within(row).getByText("This contact is listed twice.")).toBeInTheDocument();
  });

  it("an emptied Introduction is sent as an empty string, not the editor's empty paragraph", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf({ ...DOC, contactsPage: { ...PAGE, introHtml: "<p></p>" } }));
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Page heading");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const sent = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { value: SiteSettings["contactsPage"] };
    expect(sent.value.introHtml).toBe("");
  });

  it("an Introduction server error is announced and describes the editor; Group link has a hint", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "contactsPage.introHtml", message: "Keep it to 50000 characters or fewer." }]));
    renderScreen();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Keep it to 50000 characters or fewer.");
    expect(screen.getByRole("textbox", { name: "Introduction" })).toHaveAccessibleDescription(/24-hour media line.*50000 characters/);
    const row = screen.getByRole("group", { name: "Contact 1" });
    expect(within(row).getByLabelText("Group link")).toHaveAccessibleDescription(/\/ministries\/health\/.*https:\/\//);
  });

  it("a Core.Admin without NRMS.SiteEditor sees the fields disabled", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByLabelText("Page heading")).toBeDisabled();
    expect(screen.getByLabelText("List heading")).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Contact 1" })).getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
  });
});
