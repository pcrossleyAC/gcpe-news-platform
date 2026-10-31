import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { publishAndConfirm } from "./publishTestHelpers";
import type { SettingsState } from "./api";

const BASE: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});

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

const stateOf = (document: SiteSettings, errors: SettingsState["errors"] = []): SettingsState => ({
  live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null },
  document,
  draftSections: [], draft: null,
  baseRevision: 4,
  errors,
});

import { FooterScreen } from "./FooterScreen";

const FOOTER: SiteSettings["footer"] = {
  helpText: "Need help? Call us.",
  helpLinks: [
    { id: "contact", text: "Contact Us", url: "/contact" },
    { id: "faq", text: "FAQ", url: "/faq" },
  ],
  connectLinks: [{ text: "Social", url: "/connect" }],
  moreInfoLinks: [{ text: "Home", url: "https://www2.gov.bc.ca/" }],
  copyrightHolder: "Province of British Columbia",
  landAcknowledgement: "We acknowledge the territories.",
};
const DOC: SiteSettings = { ...BASE, footer: FOOTER };

function renderScreen() {
  return render(
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>
            <FooterScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("FooterScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows help text, the three lists and the copyright hint; h1 and document title are 'Footer links'", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Footer links", level: 1 });
    expect(await screen.findByLabelText("Help text")).toHaveValue("Need help? Call us.");
    expect(screen.getByRole("group", { name: "Help links" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Connect with Us links" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "More Info links" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Contact Us")).toBeInTheDocument();
    expect(screen.getByLabelText(/Copyright holder/)).toHaveValue("Province of British Columbia");
    expect(screen.getByText(`Shows as “© ${new Date().getFullYear()} Province of British Columbia”`)).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Footer links — GCPE News Staff"));
  });

  it("moving a link moves its id, and publishing sends only the footer with ids kept", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const help = await screen.findByRole("group", { name: "Help links" });
    await user.click(within(help).getByRole("button", { name: "Move link 1 down" }));
    await publishAndConfirm(user, screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    expect(post.body).toEqual({
      baseRevision: 4,
      section: "footer",
      value: { ...FOOTER, helpLinks: [FOOTER.helpLinks[1], FOOTER.helpLinks[0]] },
    });
  });

  it("publishing an edited 'Contact Us' sends section footer only", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByDisplayValue("Contact Us");
    await user.clear(field);
    await user.type(field, "Contact");
    await publishAndConfirm(user, screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { section: string; value: SiteSettings["footer"] };
    expect(body.section).toBe("footer");
    expect(body.value.helpLinks[0]).toEqual({ id: "contact", text: "Contact", url: "/contact" });
    expect(body.value.copyrightHolder).toBe("Province of British Columbia");
  });

  it("shows the land acknowledgement, prefilled, and saves an edit with the footer section", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Land acknowledgement");
    expect(field).toHaveValue("We acknowledge the territories.");
    expect(screen.getByText("Shown in a band above the footer on every page. Plain text. Leave it empty to hide the band.")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "Changed.");
    await publishAndConfirm(user, screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    expect(post.body).toEqual({ baseRevision: 4, section: "footer", value: { ...FOOTER, landAcknowledgement: "Changed." } });
  });

  it("shows a server error on the land acknowledgement", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "footer.landAcknowledgement", message: "Use plain text." }]));
    renderScreen();
    expect(await screen.findByText("Use plain text.")).toBeInTheDocument();
  });

  it("shows server errors on the help text and copyright holder", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "footer.copyrightHolder", message: "Enter who holds the copyright." }, { field: "footer.helpText", message: "Use plain text." }]));
    renderScreen();
    expect(await screen.findByText("Enter who holds the copyright.")).toBeInTheDocument();
    expect(screen.getByText("Use plain text.")).toBeInTheDocument();
  });

  it("a list-size error and a row error with no field name show on their list", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [
      { field: "footer.helpLinks", message: "Keep the list to 10 or fewer." },
      { field: "footer.connectLinks[0]", message: "This link is listed twice." },
    ]));
    renderScreen();
    const help = await screen.findByRole("group", { name: "Help links" });
    expect(await within(help).findByRole("alert")).toHaveTextContent("Keep the list to 10 or fewer.");
    const connect = screen.getByRole("group", { name: "Connect with Us links" });
    expect(within(within(connect).getByRole("group", { name: "Link 1" })).getByText("This link is listed twice.")).toBeInTheDocument();
  });

  it("Core.Admin alone sees disabled inputs and no write buttons", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByLabelText("Help text")).toBeDisabled();
    expect(screen.getByLabelText(/Copyright holder/)).toBeDisabled();
    expect(screen.getByLabelText("Land acknowledgement")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add a link" })).toBeNull();
  });
});
