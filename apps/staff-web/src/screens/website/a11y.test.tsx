/**
 * axe checks for every Website screen (task-5-brief.md's acceptance item: "axe clean on every
 * screen"), one render per screen plus one with a dialog open where a screen has one — same
 * helper/pattern as screens/release/documents/a11y.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { CarouselScreen } from "./CarouselScreen";
import { PinsScreen } from "./PinsScreen";
import { LiveFeedScreen } from "./LiveFeedScreen";
import { BlueBridgeScreen } from "./BlueBridgeScreen";
import { LinksScreen } from "./LinksScreen";
import { FilesScreen } from "./FilesScreen";
import { FeaturedScreen } from "./FeaturedScreen";
import { LogScreen } from "./LogScreen";
import { BannerScreen } from "./settings/BannerScreen";
import { FooterScreen } from "./settings/FooterScreen";
import { SocialScreen } from "./settings/SocialScreen";
import { ThemeScreen } from "./settings/ThemeScreen";
import { MinistryPagesScreen } from "./settings/MinistryPagesScreen";
import { MediaContactsScreen } from "./settings/MediaContactsScreen";
import { PageTextScreen } from "./settings/PageTextScreen";
import { NavigationScreen } from "./settings/NavigationScreen";
import { SiteIdentityScreen } from "./settings/SiteIdentityScreen";
import { HistoryScreen } from "./settings/HistoryScreen";
import type { SettingsState } from "./settings/api";
import type { CarouselsResponse, LinksView, ListFilesResult, LiveFeedView, PinView } from "./types";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/** Same jsdom-only carve-out as release/documents/a11y.test.tsx's seriousViolationsWithModalOpen. */
async function seriousViolationsWithModalOpen(container: Element) {
  const violations = await seriousViolations(container);
  return violations.filter((v) => v.id !== "aria-hidden-focus");
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

function stub(roles: string[], routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      for (const [prefix, body] of Object.entries(routes)) {
        if (url === prefix || url.startsWith(`${prefix}?`)) return jsonResponse(200, body);
      }
      return jsonResponse(200, {});
    }),
  );
}

const CAROUSELS: CarouselsResponse = {
  live: { id: "c1", state: "live", goLiveAt: null, wentLiveAt: "2026-01-01T00:00:00.000Z", version: 1, slides: [{ id: "s1", headline: "H", summary: "S", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] },
  next: null,
  past: [],
};
const CAROUSELS_WITH_NEXT: CarouselsResponse = {
  ...CAROUSELS,
  next: { id: "n1", state: "next", goLiveAt: "2027-01-01T12:00:00.000Z", wentLiveAt: null, version: 1, slides: [{ id: "ns1", headline: "H", summary: "S", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] },
};
const PINS: PinView[] = [
  { slot: "primary", pinned: false, version: 1, slide: { id: "p1", headline: "H", summary: "S", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null } },
  { slot: "secondary", pinned: true, version: 1, slide: { id: "p2", headline: "H2", summary: "S2", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "right", hasImage: false, imageUrl: null } },
];
const LIVE_FEED: LiveFeedView = { enabled: false, manifestUrl: "", m3uUrl: "", version: 1 };
const LINKS: LinksView = { version: 1, links: [{ id: "l1", text: "First", url: "https://a.invalid" }] };
const FILES: ListFilesResult = { total: 1, files: [{ id: "f1", name: "report.pdf", url: "/files/report.pdf", contentType: "application/pdf", size: 10, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "u" }] };

describe("accessibility — Website section screens", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("CarouselScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/carousels": CAROUSELS });
    const { container } = render(withAuth(<CarouselScreen />));
    await screen.findByRole("heading", { name: "Carousel", level: 1 });
    await screen.findByText("Slide 1 headline", { exact: false });
    expect(await seriousViolations(container)).toEqual([]);
  });

  // Fix round 1, item 2: CarouselScreen's three dialogs (remove slide, make live, delete next)
  // were never axe-checked — all three need a next carousel (with a slide, for remove-slide).
  it("CarouselScreen, with the remove-slide confirm dialog open", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/carousels": CAROUSELS_WITH_NEXT });
    const { container } = render(withAuth(<CarouselScreen />));
    const user = userEvent.setup();
    // Both the Live and Next sections number their own slides "Slide 1" — scope to the Next
    // section (CAROUSELS_WITH_NEXT's live slide and next slide would otherwise collide).
    const nextSection = await screen.findByRole("region", { name: "Next carousel" });
    await user.click(within(nextSection).getByRole("button", { name: "Remove slide 1" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });

  it("CarouselScreen, with the make-live confirm dialog open", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/carousels": CAROUSELS_WITH_NEXT });
    const { container } = render(withAuth(<CarouselScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Make live now" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });

  it("CarouselScreen, with the delete-next confirm dialog open", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/carousels": CAROUSELS_WITH_NEXT });
    const { container } = render(withAuth(<CarouselScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete next carousel" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });

  it("PinsScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/pins": PINS });
    const { container } = render(withAuth(<PinsScreen />));
    await screen.findByRole("heading", { name: "Emergency pins", level: 1 });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("LiveFeedScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/live-feed": LIVE_FEED });
    const { container } = render(withAuth(<LiveFeedScreen />));
    await screen.findByRole("heading", { name: "Live Feed", level: 1 });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("BlueBridgeScreen, with the confirm dialog open", async () => {
    stub(["Core.Admin"], { "/nrms/api/site/blue-bridge": { on: false, version: 1, updatedAt: null, warning: "Do not click OK unless you have approval from IGRS" } });
    const { container } = render(withAuth(<BlueBridgeScreen />));
    await screen.findByText("Do not click OK unless you have approval from IGRS");
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "Project Blue Bridge" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });

  it("LinksScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/links": LINKS });
    const { container } = render(withAuth(<LinksScreen />));
    await screen.findByRole("heading", { name: "Resource links", level: 1 });
    await screen.findByDisplayValue("First");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("FilesScreen, with the delete-confirmation dialog open", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/files": FILES });
    const { container } = render(withAuth(<FilesScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete report.pdf" }));
    await screen.findByRole("dialog");
    expect(await seriousViolationsWithModalOpen(container)).toEqual([]);
  });

  it("FeaturedScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/features": [] });
    const { container } = render(withAuth(<FeaturedScreen />));
    await screen.findByRole("heading", { name: "What’s featured where", level: 1 });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("LogScreen", async () => {
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/log": [] });
    const { container } = render(withAuth(<LogScreen />));
    await screen.findByRole("heading", { name: "Website log", level: 1 });
    await screen.findByText("No log entries yet.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("BannerScreen, with a field error, another section's error and a link row", async () => {
    const document = defaultSiteSettings({
      colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
      footerLinks: [],
    });
    const state: SettingsState = {
      live: { revision: 3, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null },
      document: { ...document, banner: { ...document.banner, enabled: true, message: "<b>x</b>", links: [{ text: "More", url: "http://x.invalid" }] } },
      draft: { baseRevision: 3, updatedAt: "2026-10-27T18:05:00.000Z" },
      baseRevision: 3,
      errors: [
        { field: "banner.message", message: "Use plain text. Add links below instead of HTML." },
        { field: "banner.links[0].url", message: "Must start with https:// or / (a page on this site)." },
        { field: "footer.copyrightHolder", message: "Enter who holds the copyright." },
      ],
    };
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<BannerScreen />));
    await screen.findByRole("heading", { name: "Site banner", level: 1 });
    await screen.findByDisplayValue("More");
    expect(await seriousViolations(container)).toEqual([]);
  });
  const settingsState = (mutate: (d: SiteSettings) => SiteSettings, errors: SettingsState["errors"]): SettingsState => {
    const base = defaultSiteSettings({
      colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
      footerLinks: [],
    });
    return {
      live: { revision: 3, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null },
      document: mutate(base),
      draft: { baseRevision: 3, updatedAt: "2026-10-27T18:05:00.000Z" },
      baseRevision: 3,
      errors,
    };
  };

  it("FooterScreen, with link rows and field errors", async () => {
    const state = settingsState(
      (d) => ({ ...d, footer: { ...d.footer, helpLinks: [{ id: "contact", text: "Contact Us", url: "/contact" }], copyrightHolder: "" } }),
      [{ field: "footer.copyrightHolder", message: "Enter who holds the copyright." }, { field: "footer.helpLinks[0].url", message: "Must start with https:// or / (a page on this site)." }],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<FooterScreen />));
    await screen.findByRole("heading", { name: "Footer links", level: 1 });
    await screen.findByDisplayValue("Contact Us");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("FooterScreen, with a populated land acknowledgement and its error", async () => {
    const ack = "We acknowledge with respect the territories <b>here</b>.";
    const state = settingsState((d) => ({ ...d, footer: { ...d.footer, landAcknowledgement: ack } }), [
      { field: "footer.landAcknowledgement", message: "Use plain text." },
    ]);
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<FooterScreen />));
    await screen.findByRole("heading", { name: "Footer links", level: 1 });
    await screen.findByDisplayValue(ack);
    expect(await screen.findAllByText("Use plain text.")).not.toHaveLength(0);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("MediaContactsScreen, with contact rows and field errors", async () => {
    const state = settingsState(
      (d) => ({
        ...d,
        contactsPage: {
          ...d.contactsPage,
          introHtml: "<p>Call <b>250-555-0100</b>.</p>",
          contacts: [
            { group: "Office of the Premier", groupUrl: "/ministries/office-of-the-premier/", subgroup: "", name: "Media Line", phone: "250 555 0100", cell: "", email: "bad", placement: "bottom" },
            { group: "Other", groupUrl: "", subgroup: "", name: "Desk", phone: "", cell: "", email: "", placement: "top" },
          ],
        },
      }),
      [
        { field: "contactsPage.contacts[0].email", message: "Enter an email address like name@gov.bc.ca." },
        { field: "contactsPage.introHtml", message: "Too long." },
      ],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<MediaContactsScreen />));
    await screen.findByRole("heading", { name: "Media contacts page", level: 1 });
    await screen.findByDisplayValue("Media Line");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("PageTextScreen, with rich fields, an archive link row and field errors", async () => {
    const state = settingsState(
      (d) => ({
        ...d,
        pageText: {
          ...d.pageText,
          privacy: { ...d.pageText.privacy, bodyHtml: "<p>Statement</p>" },
          collectionNotice: { ...d.pageText.collectionNotice, bodyHtml: "<p>Notice</p>" },
          searchArchiveLinks: [{ text: "2015", url: "http://x.invalid" }],
        },
      }),
      [
        { field: "pageText.assetLicence.url", message: "Must start with https:// or / (a page on this site)." },
        { field: "pageText.privacy.bodyHtml", message: "Too long." },
        { field: "pageText.searchArchiveLinks[0].url", message: "Must start with https:// or / (a page on this site)." },
      ],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<PageTextScreen />));
    await screen.findByRole("heading", { name: "Page text", level: 1 });
    await screen.findByDisplayValue("2015");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("NavigationScreen, with header links at the limit, a row error and field errors", async () => {
    const state = settingsState(
      (d) => ({
        ...d,
        navigation: { ...d.navigation, headerLinks: [1, 2, 3, 4].map((n) => ({ text: `Link ${n}`, url: `/l${n}/` })) },
      }),
      [
        { field: "navigation.labels.loadMoreNews", message: "Enter some text." },
        { field: "navigation.headerLinks[0].url", message: "Must start with https:// or / (a page on this site)." },
        { field: "navigation.headerLinks", message: "Keep the list to 4 or fewer." },
      ],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<NavigationScreen />));
    await screen.findByRole("heading", { name: "Navigation and labels", level: 1 });
    await screen.findByDisplayValue("Link 4");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SiteIdentityScreen, with a field error on each field", async () => {
    const state = settingsState(
      (d) => ({ ...d, siteIdentity: { ...d.siteIdentity, description: "Plain", twitterSite: "BCGov" } }),
      [
        { field: "siteIdentity.twitterSite", message: "Enter an X account like @BCGovNews." },
        { field: "siteIdentity.blueBridge.message", message: "The only placeholder is {age}." },
        { field: "siteIdentity.blueBridge.birthDate", message: "Enter a date like 1948-11-14." },
      ],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<SiteIdentityScreen />));
    await screen.findByRole("heading", { name: "Site identity", level: 1 });
    await screen.findByDisplayValue("Plain");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SocialScreen, with featured and account rows and a row error", async () => {
    const state = settingsState(
      (d) => ({ ...d, connect: { ...d.connect, facebook: { featured: [{ id: "fb", text: "BC Gov", url: "https://facebook.com/bcgov", summary: "<b>x</b>" }], accounts: [{ text: "Other", url: "https://facebook.com/o" }] } } }),
      [{ field: "connect.facebook.featured[0].summary", message: "Use plain text, 200 characters or fewer." }],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<SocialScreen />));
    await screen.findByRole("heading", { name: "Social links", level: 1 });
    await screen.findByDisplayValue("BC Gov");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SocialScreen, with errors on the Connect page fields", async () => {
    const state = settingsState(
      (d) => ({ ...d, connect: { ...d.connect, policyLink: { text: "", url: "https://x.invalid/p" }, intro: "<b>hi</b>" } }),
      [
        { field: "connect.policyLink.text", message: "Enter the link text." },
        { field: "connect.intro", message: "Use plain text." },
      ],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<SocialScreen />));
    await screen.findByRole("heading", { name: "Social links", level: 1 });
    expect(await screen.findByLabelText("Introduction")).toBeInvalid();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("ThemeScreen, with a contrast error, a faint colour and the other badges", async () => {
    const state = settingsState(
      (d) => ({ ...d, theme: { colors: { ...d.theme.colors, bannerInfo: "#8899AA" } } }),
      [{ field: "theme.colors.bannerInfo", message: "Too faint to read behind white text (2.9:1, needs 4.5:1). Pick a darker shade." }],
    );
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<ThemeScreen />));
    await screen.findByRole("heading", { name: "Theme colours", level: 1 });
    await screen.findByDisplayValue("#8899AA");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("MinistryPagesScreen, with a field error", async () => {
    const state = settingsState((d) => ({ ...d, ministryPages: { ...d.ministryPages, ministryVideos: "" } }), [{ field: "ministryPages.ministryVideos", message: "Enter a heading." }]);
    stub(["NRMS.SiteEditor"], { "/nrms/api/site/settings": state });
    const { container } = render(withAuth(<MinistryPagesScreen />));
    await screen.findByRole("heading", { name: "Ministry page headings", level: 1 });
    await screen.findByDisplayValue("Media Contacts");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("HistoryScreen, with the restore confirmation open", async () => {
    const info = (revision: number) => ({ revision, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: revision === 1 ? "First" : null });
    const snapshot = settingsState((d) => d, []).document;
    stub(["NRMS.SiteEditor"], {
      "/nrms/api/site/settings/history": { live: 2, revisions: [info(2), info(1)] },
      "/nrms/api/site/settings/history/1": { info: info(1), document: snapshot, differing: ["banner", "theme"] },
    });
    render(withAuth(<HistoryScreen />));
    await screen.findByRole("heading", { name: "Settings history", level: 1 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 1" }));
    await screen.findByRole("dialog", { name: "Restore revision 1?" });
    // The dialog renders in a portal under body, outside the render container.
    expect(await seriousViolationsWithModalOpen(document.body)).toEqual([]);
  });
});
