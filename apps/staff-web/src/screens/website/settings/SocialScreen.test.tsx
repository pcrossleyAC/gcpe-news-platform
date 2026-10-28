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
  draft: null,
  baseRevision: 4,
  errors,
});

import { SocialScreen } from "./SocialScreen";

const DOC: SiteSettings = {
  ...BASE,
  connect: {
    ...BASE.connect,
    facebook: { featured: [{ id: "fb1", text: "BC Gov", url: "https://facebook.com/bcgov", summary: "Main page" }], accounts: [] },
    bluesky: {
      featured: [],
      accounts: [{ text: "Trade and Invest British Columbia", url: "https://bsky.app/profile/tibc" }],
    },
    x: { featured: [], accounts: [{ text: "b", url: "https://x.com/b" }, { text: "A", url: "https://x.com/a" }] },
  },
};

function renderScreen(url = "/") {
  return render(
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter initialEntries={[url]}>
          <RequireAuth>
            <SocialScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("SocialScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("has a tab per network labelled with its count, Facebook open by default, h1 'Social links'", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Social links", level: 1 });
    const nav = await screen.findByRole("navigation", { name: "Networks" });
    const labels = within(nav).getAllByRole("link").map((a) => a.textContent);
    expect(labels).toEqual(["Facebook 1", "X 2", "Instagram 0", "Threads 0", "Bluesky 1", "LinkedIn 0", "Flickr 0", "YouTube 0", "Blogs 0"]);
    expect(within(nav).getByRole("link", { name: "Facebook 1" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByDisplayValue("BC Gov")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Main page")).toBeInTheDocument();
    expect(screen.getByText("Save a draft before switching networks; unsaved edits on this tab are lost when you switch.")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Social links — GCPE News Staff"));
  });

  it("?network= selects the tab; an unknown one falls back to Facebook", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen("/?network=bluesky");
    expect(await screen.findByDisplayValue("Trade and Invest British Columbia")).toBeInTheDocument();
    cleanup();
    renderScreen("/?network=myspace");
    expect(await screen.findByDisplayValue("BC Gov")).toBeInTheDocument();
  });

  it("lists other accounts sorted by name, case-insensitively, and only featured is reorderable", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen("/?network=x");
    const accounts = await screen.findByRole("group", { name: "Other accounts" });
    expect(within(accounts).getAllByLabelText("Link text").map((i) => (i as HTMLInputElement).value)).toEqual(["A", "b"]);
    expect(within(accounts).queryByRole("button", { name: /Move link/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Featured accounts" })).queryByRole("button", { name: /Move link/ })).toBeNull();
  });

  it("adding BC Parks to Bluesky publishes the accounts sorted and changes only that network", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen("/?network=bluesky");
    const user = userEvent.setup();
    const accounts = await screen.findByRole("group", { name: "Other accounts" });
    await user.click(within(accounts).getByRole("button", { name: "+ Add a link" }));
    const rows = within(accounts).getAllByLabelText("Link text");
    await user.type(rows[rows.length - 1]!, "BC Parks");
    await user.type(within(accounts).getAllByLabelText("Web address").pop()!, "https://bsky.app/profile/bcparks");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { section: string; value: SiteSettings["connect"] };
    expect(body.section).toBe("connect");
    expect(body.value.bluesky.accounts.map((l) => l.text)).toEqual(["BC Parks", "Trade and Invest British Columbia"]);
    expect({ ...body.value, bluesky: undefined }).toEqual({ ...DOC.connect, bluesky: undefined });
  });

  it("featured accounts are reorderable with a Description, ids kept", async () => {
    const doc: SiteSettings = {
      ...DOC,
      connect: { ...DOC.connect, facebook: { featured: [{ id: "a", text: "A", url: "/a", summary: "one" }, { id: "b", text: "B", url: "/b" }], accounts: [] } },
    };
    const calls = stub(["NRMS.SiteEditor"], stateOf(doc));
    renderScreen();
    const user = userEvent.setup();
    const featured = await screen.findByRole("group", { name: "Featured accounts" });
    expect(within(featured).getAllByLabelText("Description (optional)")).toHaveLength(2);
    await user.click(within(featured).getByRole("button", { name: "Move link 1 down" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { value: SiteSettings["connect"] };
    expect(body.value.facebook.featured.map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("shows a markup error on its featured row", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.facebook.featured[0].summary", message: "Use plain text, 200 characters or fewer." }]));
    renderScreen();
    const featured = await screen.findByRole("group", { name: "Featured accounts" });
    expect(within(featured).getByText("Use plain text, 200 characters or fewer.")).toBeInTheDocument();
  });

  it("puts a server error on the displayed row of the stored account it names (accounts are shown sorted)", async () => {
    // Stored order is b, A: the error names stored index 0 ("b"), which is displayed second.
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.x.accounts[0].url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen("/?network=x");
    const accounts = await screen.findByRole("group", { name: "Other accounts" });
    const rowB = within(accounts).getByDisplayValue("b").closest("fieldset")!;
    const rowA = within(accounts).getByDisplayValue("A").closest("fieldset")!;
    expect(within(rowB).getByText("Must start with https:// or / (a page on this site).")).toBeInTheDocument();
    expect(within(rowA).queryByText("Must start with https:// or / (a page on this site).")).toBeNull();
  });

  it("lists errors on other networks under 'Other parts of the draft', naming the network", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.facebook.featured[0].url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen("/?network=x");
    await screen.findByRole("group", { name: "Other accounts" });
    expect(screen.getByText("Other parts of the draft have problems that block publishing:")).toBeInTheDocument();
    expect(screen.getByText(/Facebook: Must start with https/)).toBeInTheDocument();
  });

  it("shows the LinkedIn network with Government of BC featured", async () => {
    const doc: SiteSettings = {
      ...DOC,
      connect: { ...DOC.connect, linkedin: { featured: [{ id: "li1", text: "Government of BC", url: "https://www.linkedin.com/company/governmentofbc", summary: "Official page" }], accounts: [] } },
    };
    stub(["NRMS.SiteEditor"], stateOf(doc));
    renderScreen("/?network=linkedin");
    const featured = await screen.findByRole("group", { name: "Featured accounts" });
    expect(within(featured).getByDisplayValue("Government of BC")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LinkedIn", level: 2 })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Networks" })).getByRole("link", { name: "LinkedIn 1" })).toHaveAttribute("aria-current", "page");
  });

  it("edits the policy link and intro and sends them in the connect section", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const box = await screen.findByRole("group", { name: "Connect page" });
    await user.type(within(box).getByLabelText("Policy link text"), "Social media policy");
    await user.type(within(box).getByLabelText("Policy link URL"), "https://www2.gov.bc.ca/policy");
    await user.type(within(box).getByLabelText("Introduction"), "Follow the Province.");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { section: string; value: SiteSettings["connect"] };
    expect(body.section).toBe("connect");
    expect(body.value.policyLink).toEqual({ text: "Social media policy", url: "https://www2.gov.bc.ca/policy" });
    expect(body.value.intro).toBe("Follow the Province.");
  });

  it("hints where each Connect field appears and what the URL may start with", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const box = await screen.findByRole("group", { name: "Connect page" });
    expect(within(box).getByLabelText("Policy link URL")).toHaveAccessibleDescription(/https:\/\/ only \(or a page on this site starting with \/\), no spaces/);
    expect(within(box).getByLabelText("Policy link text")).toHaveAccessibleDescription(/200 characters or fewer, plain text/);
    expect(within(box).getByLabelText("Introduction")).toHaveAccessibleDescription(/top of the Connect page/);
  });

  it("a server error on connect.policyLink.url shows beside Policy link URL", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.policyLink.url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen();
    const box = await screen.findByRole("group", { name: "Connect page" });
    const url = within(box).getByLabelText("Policy link URL");
    expect(url).toBeInvalid();
    expect(url).toHaveAccessibleDescription(/Must start with https:\/\//);
        expect(within(box).queryByText("Other parts of the draft have problems that block publishing:")).toBeNull();
    expect(screen.queryByText("Other parts of the draft have problems that block publishing:")).toBeNull();
  });

  it("the pair rule: link text without a URL errors on Policy link URL, a URL without text errors on Policy link text", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.policyLink.url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen();
    const box = await screen.findByRole("group", { name: "Connect page" });
    expect(within(box).getByLabelText("Policy link URL")).toBeInvalid();
    expect(within(box).getByLabelText("Policy link text")).toBeValid();
    cleanup();
    vi.unstubAllGlobals();
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.policyLink.text", message: "Enter the link text." }]));
    renderScreen();
    const box2 = await screen.findByRole("group", { name: "Connect page" });
    const text = within(box2).getByLabelText("Policy link text");
    expect(text).toBeInvalid();
    expect(text).toHaveAccessibleDescription(/Enter the link text\./);
    expect(within(box2).getByLabelText("Policy link URL")).toBeValid();
  });

  it("an intro error shows beside Introduction and the hint stays in its description", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.intro", message: "Use plain text." }]));
    renderScreen();
    const box = await screen.findByRole("group", { name: "Connect page" });
    const intro = within(box).getByLabelText("Introduction");
    expect(intro).toBeInvalid();
    expect(intro).toHaveAccessibleDescription(/Use plain text\./);
    expect(intro).toHaveAccessibleDescription(/top of the Connect page/);
  });

  it("a too-long policy link text error keeps the hint in the description", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "connect.policyLink.text", message: "Use 200 characters or fewer." }]));
    renderScreen();
    const box = await screen.findByRole("group", { name: "Connect page" });
    const text = within(box).getByLabelText("Policy link text");
    expect(text).toHaveAccessibleDescription(/Use 200 characters or fewer\./);
    expect(text).toHaveAccessibleDescription(/200 characters or fewer, plain text/);
  });

  it("Core.Admin alone sees disabled inputs and no write buttons", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByDisplayValue("BC Gov")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});
