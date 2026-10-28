import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { caretToEnd } from "../../../../test/editorCaret";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import type { SettingsState } from "./api";
import { INTRO, LICENCE_HINT, PageTextScreen, STATEMENT_HINT } from "./PageTextScreen";

const BASE: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});
const PAGE_TEXT: SiteSettings["pageText"] = {
  notFound: { heading: "Page not found", text: "It is not here." },
  privacy: { label: "Privacy", title: "Privacy", bodyHtml: "<p>Old statement</p>" },
  live: { heading: "Live", consentHtml: "<p>Plays from {host}</p>", offAirHtml: "<p>Not live</p>" },
  collectionNotice: { heading: "Notice of Collection", bodyHtml: "<p>We collect your email.</p>" },
  subscribeHelpHtml: "<p>Call us</p>",
  assetLicence: { text: "Free to use.", linkText: "Licence", url: "https://example.invalid/licence" },
  searchArchiveLinks: [{ text: "2015", url: "https://archive.invalid/2015" }],
};
const DOC: SiteSettings = { ...BASE, pageText: PAGE_TEXT };

const stateOf = (document: SiteSettings, errors: SettingsState["errors"] = []): SettingsState => ({
  live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null },
  document,
  draft: null,
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
            <PageTextScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("PageTextScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the six fieldsets with the published values", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Page text", level: 1 });
    const names = ["Page not found", "Privacy page", "Live webcast page", "Subscribe page", "Media assets licence", "Search: older archives"];
    const groups = await Promise.all(names.map((n) => screen.findByRole("group", { name: n })));
    expect(groups).toHaveLength(6);
    expect(within(groups[0]!).getByLabelText("Text")).toHaveValue("It is not here.");
    expect(within(groups[1]!).getByRole("textbox", { name: "Statement" })).toHaveTextContent("Old statement");
    expect(within(groups[2]!).getByRole("textbox", { name: "Before play" })).toHaveTextContent("Plays from {host}");
    expect(screen.getByText("{host} is replaced by the stream's host name.")).toBeInTheDocument();
    expect(within(groups[3]!).getByLabelText("Notice heading")).toHaveValue("Notice of Collection");
    expect(within(groups[3]!).getByRole("textbox", { name: "Help line" })).toHaveTextContent("Call us");
    expect(within(groups[4]!).getByLabelText("Link URL")).toHaveValue("https://example.invalid/licence");
    expect(within(groups[5]!).getByDisplayValue("2015")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Page text — GCPE News Staff"));
  });

  it("warns that the Notice of Collection is legal text", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByText(/legal wording/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notice of Collection" })).toHaveAccessibleDescription(/privacy office/);
  });

  it("editing the privacy statement and saving sends pageText with bodyHtml from the editor", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Statement" });
    await user.click(field);
    // Through the editor, not user-event's DOM caret move, which ProseMirror's post-focus timer
    // can put back on a slow runner (test/editorCaret.ts).
    caretToEnd(field);
    await user.type(field, " more", { skipClick: true });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    const body = post.body as { section: string; baseRevision: number; value: SiteSettings["pageText"] };
    expect(body.section).toBe("pageText");
    expect(body.baseRevision).toBe(4);
    expect(body.value.privacy.bodyHtml).toContain("Old statement more");
    expect(body.value.notFound).toEqual(PAGE_TEXT.notFound);
    expect(body.value.searchArchiveLinks).toEqual(PAGE_TEXT.searchArchiveLinks);
  });

  it("a server error on pageText.assetLicence.url shows beside Link URL", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "pageText.assetLicence.url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen();
    const group = await screen.findByRole("group", { name: "Media assets licence" });
    expect(await within(group).findByText("Must start with https:// or / (a page on this site).")).toBeInTheDocument();
    expect(within(group).getByLabelText("Link URL")).toBeInvalid();
  });

  it("adds an older-archive link; an unsafe URL error shows on that row", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const group = await screen.findByRole("group", { name: "Search: older archives" });
    await user.click(within(group).getByRole("button", { name: "+ Add a link" }));
    const texts = within(group).getAllByLabelText("Link text");
    await user.type(texts[1]!, "2010");
    await user.type(within(group).getAllByLabelText("Web address")[1]!, "https://archive.invalid/2010");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { value: SiteSettings["pageText"] };
    expect(body.value.searchArchiveLinks).toEqual([
      { text: "2015", url: "https://archive.invalid/2015" },
      { text: "2010", url: "https://archive.invalid/2010" },
    ]);

    cleanup();
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "pageText.searchArchiveLinks[0].url", message: "Must start with https:// or / (a page on this site)." }]));
    renderScreen();
    const again = await screen.findByRole("group", { name: "Search: older archives" });
    expect(await within(again).findByText("Must start with https:// or / (a page on this site).")).toBeInTheDocument();
    expect(within(again).getByLabelText("Web address")).toBeInvalid();
  });

  it("a server error on the privacy statement is announced beside the editor and describes it", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "pageText.privacy.bodyHtml", message: "Keep it to 50000 characters or fewer." }]));
    renderScreen();
    const group = await screen.findByRole("group", { name: "Privacy page" });
    const alert = await within(group).findByRole("alert");
    expect(alert).toHaveTextContent("Keep it to 50000 characters or fewer.");
    expect(within(group).getByRole("textbox", { name: "Statement" })).toHaveAccessibleDescription(`${STATEMENT_HINT} Keep it to 50000 characters or fewer.`);
  });

  it("the intro says which boxes are required; the privacy label, statement and licence have plain hints", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByText(INTRO)).toBeInTheDocument();
    expect(INTRO).toMatch(/page not found heading and the privacy page title are required/);
    const privacy = screen.getByRole("group", { name: "Privacy page" });
    expect(within(privacy).getByLabelText("Label")).toHaveAccessibleDescription(/above the title on the privacy page/);
    expect(within(screen.getByRole("group", { name: "Media assets licence" })).getByLabelText("Text")).toHaveAccessibleDescription(LICENCE_HINT);
    expect(LICENCE_HINT).toMatch(/period is added/);
  });

  it("a too-many-links error on the older archives list shows on the list", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "pageText.searchArchiveLinks", message: "Keep the list to 10 or fewer." }]));
    renderScreen();
    const group = await screen.findByRole("group", { name: "Search: older archives" });
    expect(await within(group).findByRole("alert")).toHaveTextContent("Keep the list to 10 or fewer.");
  });

  it("emptied rich-text boxes are sent as empty strings", async () => {
    const empty = { ...PAGE_TEXT, live: { ...PAGE_TEXT.live, offAirHtml: "<p></p>" }, subscribeHelpHtml: "<p><br></p>" };
    const calls = stub(["NRMS.SiteEditor"], stateOf({ ...DOC, pageText: empty }));
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "Privacy page" });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { value: SiteSettings["pageText"] };
    expect(body.value.live.offAirHtml).toBe("");
    expect(body.value.subscribeHelpHtml).toBe("");
    expect(body.value.privacy.bodyHtml).toBe(PAGE_TEXT.privacy.bodyHtml);
  });

  it("Core.Admin alone sees disabled inputs and no write buttons", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByLabelText("Notice heading")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add a link" })).toBeNull();
  });
});
