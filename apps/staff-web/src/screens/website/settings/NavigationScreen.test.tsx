import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, LABEL_KEYS, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import type { SettingsState } from "./api";
import { FOOTER_CONNECT_HINT, HEADER_LINKS_HINT, INTRO, LABEL_FIELDS, LABEL_HINTS, LISTING_HINTS, NavigationScreen } from "./NavigationScreen";

const BASE: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});
const NAV: SiteSettings["navigation"] = {
  ...BASE.navigation,
  newsLabel: "News",
  liveLabel: "Live Webcast",
  headerLinks: [{ text: "Subscribe", url: "/subscribe/" }],
  showHeaderSearch: true,
  footerConnectHeading: "Connect with Us",
  footerMoreInfoHeading: "More Info",
  labels: { ...BASE.navigation.labels, loadMoreNews: "Load More News", connectWithUs: "Connect With Us" },
  listingTitles: { releases: "Releases", stories: "Stories", factsheets: "Factsheets", updates: "Updates" },
};
const DOC: SiteSettings = { ...BASE, navigation: NAV };

const stateOf = (document: SiteSettings, errors: SettingsState["errors"] = []): SettingsState => ({
  live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null },
  document,
  draftSections: [], draft: null,
  baseRevision: 4,
  errors,
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

function renderScreen() {
  return render(
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>
            <NavigationScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("NavigationScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows header, footer headings, page labels and listing titles from the published navigation", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Navigation and labels", level: 1 });
    const header = await screen.findByRole("group", { name: "Header" });
    expect(within(header).getByLabelText("News menu label")).toHaveValue("News");
    expect(within(header).getByLabelText("Live webcast button label")).toHaveValue("Live Webcast");
    expect(within(header).getByDisplayValue("Subscribe")).toBeInTheDocument();
    expect(within(header).getByRole("checkbox", { name: "Show the search box in the header" })).toBeChecked();
    const footer = screen.getByRole("group", { name: "Footer headings" });
    expect(within(footer).getAllByRole("textbox")).toHaveLength(2);
    expect(within(footer).getByDisplayValue("More Info")).toBeInTheDocument();
    const labels = screen.getByRole("group", { name: "Page labels" });
    expect(within(labels).getAllByRole("textbox")).toHaveLength(LABEL_KEYS.length);
    expect(within(labels).getByLabelText("Home page: Connect With Us heading")).toHaveValue("Connect With Us");
    expect(within(labels).getByLabelText("Slide link label (when a slide has none)")).toBeInTheDocument();
    expect(within(labels).getByLabelText("Load more news button label")).toHaveValue("Load More News");
    const listing = screen.getByRole("group", { name: "Listing titles" });
    expect(within(listing).getAllByRole("textbox")).toHaveLength(4);
    expect(within(listing).getByLabelText("Releases page title")).toHaveValue("Releases");
    expect(within(listing).getByLabelText("Updates page title")).toHaveValue("Updates");
    await waitFor(() => expect(document.title).toBe("Navigation and labels — GCPE News Staff"));
  });

  it("every page label, listing title and footer heading has its label and a hint tied to the field", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("group", { name: "Page labels" });
    for (const key of LABEL_KEYS) {
      expect(screen.getByLabelText(LABEL_FIELDS[key])).toHaveAccessibleDescription(LABEL_HINTS[key]);
    }
    expect(new Set(LABEL_KEYS.map((k) => LABEL_FIELDS[k])).size).toBe(LABEL_KEYS.length);
    expect(screen.getByLabelText("Releases page title")).toHaveAccessibleDescription(LISTING_HINTS.releases);
    expect(screen.getByLabelText("Footer: Connect with Us column heading")).toHaveAccessibleDescription(FOOTER_CONNECT_HINT);
    expect(FOOTER_CONNECT_HINT).toMatch(/first \(left\)/);
  });

  it("unchecking 'Show the search box' and saving sends showHeaderSearch: false", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Show the search box in the header" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { section: string; baseRevision: number; value: SiteSettings["navigation"] };
    expect(body.section).toBe("navigation");
    expect(body.baseRevision).toBe(4);
    expect(body.value.showHeaderSearch).toBe(false);
    expect(body.value.labels).toEqual(NAV.labels);
    expect(body.value.headerLinks).toEqual(NAV.headerLinks);
  });

  it("a server error on navigation.labels.loadMoreNews shows beside its field", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "navigation.labels.loadMoreNews", message: "Enter some text." }]));
    renderScreen();
    const labels = await screen.findByRole("group", { name: "Page labels" });
    expect(await within(labels).findByText("Enter some text.")).toBeInTheDocument();
    expect(within(labels).getByLabelText("Load more news button label")).toBeInvalid();
  });

  it("server errors show on the header, footer and listing fields", async () => {
    stub(
      ["NRMS.SiteEditor"],
      stateOf(DOC, [
        { field: "navigation.newsLabel", message: "Keep it to 40 characters or fewer." },
        { field: "navigation.footerMoreInfoHeading", message: "Keep it to 60 characters or fewer." },
        { field: "navigation.listingTitles.stories", message: "Enter some text." },
      ]),
    );
    renderScreen();
    await screen.findByRole("group", { name: "Header" });
    expect(screen.getByLabelText("News menu label")).toBeInvalid();
    expect(screen.getByLabelText("Footer: More Info column heading")).toBeInvalid();
    expect(screen.getByLabelText("Stories page title")).toBeInvalid();
    expect(screen.getByText("Enter some text.")).toBeInTheDocument();
  });

  it("header links: add is disabled at 4 with a hint, and a too-many-links server error still shows", async () => {
    const four = [1, 2, 3, 4].map((n) => ({ text: `L${n}`, url: `/l${n}/` }));
    stub(["NRMS.SiteEditor"], stateOf({ ...DOC, navigation: { ...NAV, headerLinks: four } }, [{ field: "navigation.headerLinks", message: "Keep the list to 4 or fewer." }]));
    renderScreen();
    const links = await screen.findByRole("group", { name: "Header links" });
    expect(within(links).getByRole("button", { name: "+ Add a link" })).toBeDisabled();
    expect(within(links).getByText("You can have at most 4 links.")).toBeInTheDocument();
    expect(await within(links).findByRole("alert")).toHaveTextContent("Keep the list to 4 or fewer.");
    expect(within(links).getByRole("button", { name: "Move link 1 down" })).toBeInTheDocument();
  });

  it("header links: a row-level and a field error land on their rows", async () => {
    stub(
      ["NRMS.SiteEditor"],
      stateOf(DOC, [{ field: "navigation.headerLinks[0].url", message: "Must start with https:// or / (a page on this site)." }]),
    );
    renderScreen();
    const links = await screen.findByRole("group", { name: "Header links" });
    expect(await within(links).findByText("Must start with https:// or / (a page on this site).")).toBeInTheDocument();
    expect(within(links).getByLabelText("Web address")).toBeInvalid();
  });

  it("the intro says which boxes are required and the header links hint says the limit", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByText(INTRO)).toBeInTheDocument();
    expect(INTRO).toMatch(/menu label, the webcast button label, every page label and every listing title are required/);
    expect(INTRO).toMatch(/footer headings are optional/i);
    expect(screen.getByRole("group", { name: "Header links" })).toHaveAccessibleDescription(HEADER_LINKS_HINT);
    expect(HEADER_LINKS_HINT).toMatch(/up to 4/i);
  });

  it("Core.Admin alone sees disabled inputs and no write buttons", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByLabelText("News menu label")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Show the search box in the header" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add a link" })).toBeNull();
  });
});
