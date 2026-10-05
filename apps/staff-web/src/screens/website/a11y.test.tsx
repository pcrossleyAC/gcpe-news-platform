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
  live: { id: "c1", state: "live", goLiveAt: null, wentLiveAt: "2026-01-01T00:00:00.000Z", version: 1, slides: [{ id: "s1", headline: "H", summary: "S", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] },
  next: null,
  past: [],
};
const CAROUSELS_WITH_NEXT: CarouselsResponse = {
  ...CAROUSELS,
  next: { id: "n1", state: "next", goLiveAt: "2027-01-01T12:00:00.000Z", wentLiveAt: null, version: 1, slides: [{ id: "ns1", headline: "H", summary: "S", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null }] },
};
const PINS: PinView[] = [
  { slot: "primary", pinned: false, version: 1, slide: { id: "p1", headline: "H", summary: "S", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null } },
  { slot: "secondary", pinned: true, version: 1, slide: { id: "p2", headline: "H2", summary: "S2", actionUrl: "", facebookPostUrl: "", justify: "right", hasImage: false, imageUrl: null } },
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
});
