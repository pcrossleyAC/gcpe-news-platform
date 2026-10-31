import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { publishAndConfirm } from "./publishTestHelpers";
import { BannerScreen } from "./BannerScreen";
import type { SettingsState } from "./api";

const DOC: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [{ label: "Home", url: "https://www2.gov.bc.ca/" }],
});

const NOTHING_LIVE: SettingsState = { live: null, document: DOC, draftSections: [], draft: null, baseRevision: null, errors: [] };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

function stub(roles: string[], handler: Handler, initial: SettingsState = NOTHING_LIVE, config: () => Promise<Response> | Response = () => jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true })) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return config();
      const handled = await handler(call);
      if (handled) return handled;
      if (url === "/nrms/api/site/settings" && call.method === "GET") return jsonResponse(200, initial);
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
            <BannerScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

const withBanner = (state: SettingsState, banner: Partial<SiteSettings["banner"]>): SettingsState => ({
  ...state,
  document: { ...state.document, banner: { ...state.document.banner, ...banner } },
});

describe("BannerScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("loads, says nothing is published yet, and its document title matches the h1", async () => {
    stub(["NRMS.SiteEditor"], () => undefined);
    renderScreen();
    await screen.findByRole("heading", { name: "Site banner", level: 1 });
    expect(await screen.findByText("Nothing published yet; the site uses its built-in defaults.")).toBeInTheDocument();
    expect(screen.getByText("No unpublished changes")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Site banner — GCPE News Staff"));
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("shows the live revision and a stored schedule in BC time", async () => {
    const live = withBanner(
      { ...NOTHING_LIVE, live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null }, baseRevision: 4 },
      { enabled: true, message: "Hi", startsAt: "2026-11-02T17:00:00.000Z", endsAt: null },
    );
    stub(["NRMS.SiteEditor"], () => undefined, live);
    renderScreen();
    expect(await screen.findByText(/^Live: revision 4, published by Sam on /)).toBeInTheDocument();
    // 2026-11-02 is after BC's switch to permanent UTC-7: 17:00Z is 10:00 in Vancouver.
    expect(screen.getByLabelText(/Show from/)).toHaveValue("2026-11-02T10:00");
    expect(screen.getByLabelText(/Hide after/)).toHaveValue("");
  });

  it("Ctrl+S (⌘S on a Mac) from a field is Save draft (never Publish); the button shows the keys", async () => {
    let state = NOTHING_LIVE;
    const calls = stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/draft" && c.method === "PUT") {
        state = withBanner({ ...state, draft: { baseRevision: null, updatedAt: "2026-10-27T18:00:00.000Z" } }, { enabled: true, message: "Roads closed" });
        return jsonResponse(200, state);
      }
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Information" }));
    const message = screen.getByLabelText("Message");
    await user.type(message, "Roads closed");
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveAttribute("aria-keyshortcuts", "Control+S");
    fireEvent.keyDown(message, { key: "s", ctrlKey: true });
    expect(await screen.findByText("Draft saved. It isn't live until you publish.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT" || c.method === "POST").map((c) => c.url)).toEqual(["/nrms/api/site/settings/draft"]);
  });

  it("Save draft PUTs only the banner section, with BC wall-clock times, and says it isn't live", async () => {
    let state = NOTHING_LIVE;
    const calls = stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/draft" && c.method === "PUT") {
        const body = c.body as { value: Record<string, unknown> };
        state = withBanner({ ...state, draft: { baseRevision: null, updatedAt: "2026-10-27T18:00:00.000Z" } }, { enabled: true, message: String(body.value.message) });
        return jsonResponse(200, state);
      }
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Information" }));
    await user.type(screen.getByLabelText("Message"), "Roads closed");
    fireEvent.change(screen.getByLabelText(/Show from/), { target: { value: "2026-11-02T09:00" } });
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText("Draft saved. It isn't live until you publish.")).toBeInTheDocument();
    const put = calls.find((c) => c.url === "/nrms/api/site/settings/draft" && c.method === "PUT")!;
    expect(put.body).toEqual({
      baseRevision: null,
      section: "banner",
      value: { enabled: true, style: "info", message: "Roads closed", links: [], dismissible: true, startsAtLocal: "2026-11-02T09:00", endsAtLocal: null },
    });
    expect(screen.getByText("Draft saved · not yet live")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent?.startsWith("Draft saved. It isn't live until you publish."))).toBe(true));
  });

  it("Off keeps the previous style (emergency) in the PUT body", async () => {
    const calls = stub(
      ["NRMS.SiteEditor"],
      (c) => (c.url === "/nrms/api/site/settings/draft" ? jsonResponse(200, withBanner(NOTHING_LIVE, { enabled: false, style: "emergency" })) : undefined),
      withBanner(NOTHING_LIVE, { enabled: true, style: "emergency", message: "Evacuate" }),
    );
    renderScreen();
    const user = userEvent.setup();
    expect(await screen.findByRole("radio", { name: "Emergency" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Off" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/draft")).toBe(true));
    const put = calls.find((c) => c.url === "/nrms/api/site/settings/draft")!;
    expect((put.body as { value: { enabled: boolean; style: string } }).value).toMatchObject({ enabled: false, style: "emergency" });
  });

  it("drops a completely blank link row before sending", async () => {
    const calls = stub(["NRMS.SiteEditor"], (c) => (c.url === "/nrms/api/site/settings/draft" ? jsonResponse(200, NOTHING_LIVE) : undefined));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add a link" }));
    await user.click(screen.getByRole("button", { name: "+ Add a link" }));
    const rows = screen.getAllByRole("group", { name: /^Link \d$/ });
    await user.type(within(rows[1]!).getByLabelText("Link text"), "More");
    await user.type(within(rows[1]!).getByLabelText("Web address"), "/more");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/draft")).toBe(true));
    const put = calls.find((c) => c.url === "/nrms/api/site/settings/draft")!;
    expect((put.body as { value: { links: unknown[] } }).value.links).toEqual([{ text: "More", url: "/more" }]);
  });

  it("Publish with a note says which revision is live", async () => {
    let state = NOTHING_LIVE;
    const calls = stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/publish") {
        state = { ...state, live: { revision: 1, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Pat", note: "Storm" }, baseRevision: 1 };
        return jsonResponse(200, { revision: 1, state });
      }
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Note for the history log (optional)"), "Storm");
    await publishAndConfirm(user, screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Published revision 1. Visitors see it within a few minutes.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    expect(post.body).toMatchObject({ baseRevision: null, section: "banner", note: "Storm" });
    expect(screen.getByText(/^Live: revision 1, published by Pat on /)).toBeInTheDocument();
    expect(screen.getByLabelText("Note for the history log (optional)")).toHaveValue("");
  });

  it("a 422 puts the message error under Message and other sections' errors in their own list", async () => {
    const fieldErrors = [
      { field: "banner.message", message: "Use plain text. Add links below instead of HTML." },
      { field: "footer.moreInfoLinks[2].url", message: "Must start with https:// or / (a page on this site)." },
    ];
    stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/publish") return jsonResponse(422, { errors: fieldErrors.map((e) => `${e.field}: ${e.message}`), fieldErrors });
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "<b>hi</b>");
    await publishAndConfirm(user, screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Draft saved, but it has problems to fix before it can be published.")).toBeInTheDocument();
    const message = screen.getByLabelText("Message");
    expect(message).toHaveAttribute("aria-invalid", "true");
    expect(message).toHaveAccessibleDescription(expect.stringContaining("Use plain text. Add links below instead of HTML."));
    const other = screen.getByRole("region", { name: "Other parts of the draft have problems that block publishing:" });
    // Audit #12: each problem names its screen as on screen, linked.
    expect(within(other).getByRole("listitem")).toHaveTextContent("Footer links: Must start with https:// or / (a page on this site).");
    expect(within(other).getByRole("link", { name: "Footer links" })).toHaveAttribute("href", "/website/footer");
  });

  it("a 409 shows the conflict panel; keeping mine rebases and says what it builds on", async () => {
    const live = { revision: 2, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null };
    const calls = stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/publish") return jsonResponse(409, { error: "published", code: "published", live, differing: ["banner"] });
      if (c.url === "/nrms/api/site/settings/rebase") return jsonResponse(200, { ...NOTHING_LIVE, live, baseRevision: 2, draft: { baseRevision: 2, updatedAt: live.publishedAt }, alsoChangedByThem: ["theme"] });
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await publishAndConfirm(user, await screen.findByRole("button", { name: "Publish" }));

    const panel = await screen.findByRole("region", { name: "Someone published while you were editing" });
    expect(within(panel).getByText(/^Revision 2 was published by Sam on .*\. Nothing of yours was published, and your draft is saved\.$/)).toBeInTheDocument();
    expect(within(panel).getByText("Your draft differs from it in: Site banner.")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Someone published while you were editing" })).toHaveFocus();

    await user.click(within(panel).getByRole("button", { name: "Keep my site banner, on top of their version" }));
    expect(await screen.findByText("Your site banner changes now build on revision 2. Check them, then publish. Your draft still has your changes on Theme colours, which they changed too: check them before you publish them.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/nrms/api/site/settings/rebase")!.body).toMatchObject({ section: "banner" });
    expect(screen.queryByRole("region", { name: "Someone published while you were editing" })).toBeNull();
    expect(screen.getByText("Your site banner changes now build on revision 2. Check them, then publish. Your draft still has your changes on Theme colours, which they changed too: check them before you publish them.")).toHaveFocus();
  });

  it("Discard mine, use theirs deletes the draft and shows what is live", async () => {
    const live = { revision: 2, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null };
    let deleted = false;
    stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/publish") return jsonResponse(409, { error: "published", code: "published", live, differing: ["banner"] });
      if (c.url === "/nrms/api/site/settings/draft" && c.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (c.url === "/nrms/api/site/settings" && deleted) return jsonResponse(200, { ...NOTHING_LIVE, live, baseRevision: 2 });
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await publishAndConfirm(user, await screen.findByRole("button", { name: "Publish" }));
    await user.click(await screen.findByRole("button", { name: "Discard mine, use theirs" }));
    expect(await screen.findByText("Draft discarded. Showing what is live.")).toBeInTheDocument();
    expect(screen.getByText(/^Live: revision 2, published by Sam on /)).toBeInTheDocument();
  });

  it("Core.Admin without NRMS.SiteEditor sees the form disabled and no publish actions", async () => {
    stub(["Core.Admin"], () => undefined);
    renderScreen();
    expect(await screen.findByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add a link" })).toBeNull();
  });

  it("shows the message counter", async () => {
    stub(["NRMS.SiteEditor"], () => undefined);
    renderScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "Hello");
    expect(screen.getByText("5 / 300")).toBeInTheDocument();
  });

  // Fix round 1: the schedule is shown and sent in the tenant's zone, even when the config
  // answers after the settings would have.
  it("waits for a late tenant time zone (America/Moncton) before showing and sending the schedule", async () => {
    let answerConfig!: () => void;
    const configAnswered = new Promise<void>((resolve) => (answerConfig = resolve));
    const calls = stub(
      ["NRMS.SiteEditor"],
      (c) => (c.url === "/nrms/api/site/settings/draft" ? jsonResponse(200, NOTHING_LIVE) : undefined),
      withBanner(NOTHING_LIVE, { enabled: true, message: "Hi", startsAt: "2026-11-02T13:00:00.000Z" }),
      async () => {
        await configAnswered;
        return jsonResponse(200, { timeZone: "America/Moncton" });
      },
    );
    renderScreen();
    await screen.findByText("Loading…");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url === "/nrms/api/site/settings")).toBe(false);
    answerConfig();
    // 13:00Z is 09:00 in Moncton (UTC-4); Vancouver's wall-clock would be 06:00.
    await waitFor(() => expect(screen.getByLabelText(/Show from/)).toHaveValue("2026-11-02T09:00"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/draft")).toBe(true));
    expect((calls.find((c) => c.url === "/nrms/api/site/settings/draft")!.body as { value: { startsAtLocal: string } }).value.startsAtLocal).toBe("2026-11-02T09:00");
  });

  it("keeps what the editor types while a save is in flight", async () => {
    let answerSave!: () => void;
    const saveAnswered = new Promise<void>((resolve) => (answerSave = resolve));
    stub(["NRMS.SiteEditor"], async (c) => {
      if (c.url !== "/nrms/api/site/settings/draft") return undefined;
      await saveAnswered;
      return jsonResponse(200, withBanner({ ...NOTHING_LIVE, draft: { baseRevision: null, updatedAt: "2026-10-27T18:00:00.000Z" } }, { message: "Roads" }));
    });
    renderScreen();
    const user = userEvent.setup();
    const message = await screen.findByLabelText("Message");
    await user.type(message, "Roads");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.type(message, " closed");
    answerSave();
    expect(await screen.findByText("Draft saved. It isn't live until you publish.")).toBeInTheDocument();
    expect(screen.getByText("Draft saved · not yet live")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("Roads closed");
  });

  describe("audit #12: Publish and Discard draft act on the whole draft", () => {
    const drafted = (sections: SettingsState["draftSections"]): SettingsState =>
      withBanner({ ...NOTHING_LIVE, live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null }, baseRevision: 4, draft: { baseRevision: 4, updatedAt: "2026-10-27T18:00:00.000Z" }, draftSections: sections }, { enabled: true, message: "Roads closed" });

    it("the bar names every screen in the draft, each a link, and says Publish and Discard draft cover them all", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, drafted(["banner", "theme", "footer"]));
      renderScreen();
      const changes = await screen.findByText(/^Your draft has changes on/);
      expect(changes).toHaveTextContent("Your draft has changes on: Site banner, Theme colours, and Footer links.");
      expect(within(changes).getByRole("link", { name: "Theme colours" })).toHaveAttribute("href", "/website/theme");
      expect(within(changes).getByRole("link", { name: "Footer links" })).toHaveAttribute("href", "/website/footer");
      expect(within(changes).getByRole("link", { name: "Site banner" })).toHaveAttribute("href", "/website/banner");
      expect(screen.getByText("Publish and Discard draft apply to your whole draft, on every settings screen. Publish lets you publish only this screen instead.")).toBeInTheDocument();
    });

    it("Discard draft asks first, naming the other screens it will clear; Cancel keeps the draft; confirming discards as before", async () => {
      let state = drafted(["banner", "theme", "footer"]);
      const calls = stub(["NRMS.SiteEditor"], (c) => {
        if (c.url === "/nrms/api/site/settings/draft" && c.method === "DELETE") {
          state = { ...NOTHING_LIVE, live: state.live, baseRevision: 4 };
          return new Response(null, { status: 204 });
        }
        if (c.url === "/nrms/api/site/settings" && c.method === "GET") return jsonResponse(200, state);
        return undefined;
      });
      renderScreen();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Discard draft" }));
      let dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Discard your whole draft?");
      expect(dialog).toHaveTextContent("This also throws away your draft changes on Theme colours and Footer links. It can’t be undone.");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);

      await user.click(screen.getByRole("button", { name: "Discard draft" }));
      dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Discard draft" }));
      expect(await screen.findByText("Draft discarded. Showing what is live.")).toBeInTheDocument();
      expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/nrms/api/site/settings/draft"]);
      expect(screen.getByText("No unpublished changes")).toBeInTheDocument();
    });

    it("fix round 1: with unsaved typing on this screen, Discard draft says that goes too", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, drafted(["banner", "theme"]));
      renderScreen();
      const user = userEvent.setup();
      const message = await screen.findByLabelText("Message");
      await user.click(screen.getByRole("button", { name: "Discard draft" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("This throws away your draft changes on Site banner. This also throws away your draft changes on Theme colours. It can’t be undone.");
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await user.type(message, " today");
      await user.click(screen.getByRole("button", { name: "Discard draft" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "This throws away your draft changes on Site banner and anything you haven’t saved on this screen. This also throws away your draft changes on Theme colours. It can’t be undone.",
      );
    });

    it("fix round 1: unsaved typing on a screen with nothing in the draft is named on its own", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, drafted(["theme"]));
      renderScreen();
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("Message"), "!");
      await user.click(screen.getByRole("button", { name: "Discard draft" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("This throws away anything you haven’t saved on this screen. This also throws away your draft changes on Theme colours. It can’t be undone.");
    });

    it("with only this screen in the draft, Discard draft still asks, and names no other screen", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, drafted(["banner"]));
      renderScreen();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Discard draft" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("This throws away your draft changes on Site banner. It can’t be undone.");
      expect(dialog).not.toHaveTextContent("also");
    });
  });
  describe("W4: Publish asks first, and can publish only this screen (owner decision 2026-10-31)", () => {
    const LIVE = { revision: 1, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null };
    const DRAFTED: SettingsState = { ...NOTHING_LIVE, live: LIVE, baseRevision: 1, draft: { baseRevision: 1, updatedAt: LIVE.publishedAt }, draftSections: ["banner", "footer"] };

    it("names every screen whose changes go live; Cancel publishes nothing", async () => {
      const calls = stub(["NRMS.SiteEditor"], () => undefined, DRAFTED);
      renderScreen();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog", { name: "Publish your changes?" });
      expect(dialog).toHaveTextContent("Compared with what is live now, this publishes changes on: Site banner and Footer links.");
      expect(dialog).toHaveTextContent("Visitors see it within a few minutes.");
      expect(within(dialog).getByRole("button", { name: "Publish only Site banner" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Publish all changes" })).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(false);
    });

    it("Publish only Site banner sends onlySection and says the rest of the draft is kept", async () => {
      const calls = stub(
        ["NRMS.SiteEditor"],
        (c) => {
          if (c.url === "/nrms/api/site/settings/publish") {
            const live = { ...LIVE, revision: 2, publishedBy: "Pat" };
            return jsonResponse(200, { revision: 2, state: { ...DRAFTED, live, baseRevision: 2, draft: { baseRevision: 2, updatedAt: LIVE.publishedAt }, draftSections: ["footer"] } });
          }
          return undefined;
        },
        DRAFTED,
      );
      renderScreen();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Publish only Site banner" }));
      expect(await screen.findByText("Published revision 2, with only your Site banner changes. Visitors see it within a few minutes. Your draft still has changes on Footer links.")).toBeInTheDocument();
      expect(calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body).toMatchObject({ section: "banner", baseRevision: 1, onlySection: true });
      // M1: announced once the dialog has gone, in the Hub's live region.
      await waitFor(() => expect(screen.getAllByRole("status").some((e) => e.textContent?.startsWith("Published revision 2, with only"))).toBe(true));
    });

    it("with changes on this screen only, it offers just Publish; a problem elsewhere in the draft is pointed at Publish only", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, { ...DRAFTED, draftSections: ["banner"] });
      renderScreen();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Publish" }));
      let dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Compared with what is live now, this publishes changes on: Site banner.");
      expect(within(dialog).queryByRole("button", { name: /^Publish only/ })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Publish" })).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      cleanup();

      const footerProblem = { field: "footer.moreInfoLinks[0].url", message: "Must start with https:// or / (a page on this site)." };
      stub(["NRMS.SiteEditor"], () => undefined, { ...DRAFTED, errors: [footerProblem] });
      renderScreen();
      await user.click(await screen.findByRole("button", { name: "Publish" }));
      dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Footer links has problems that block publishing all changes. Publish only Site banner still works.");
    });

    it("unsaved typing on this screen counts as a change here", async () => {
      stub(["NRMS.SiteEditor"], () => undefined, { ...DRAFTED, draftSections: ["footer"] });
      renderScreen();
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("Message"), "Road closed");
      await user.click(screen.getByRole("button", { name: "Publish" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("this publishes changes on: Site banner and Footer links.");
      expect(within(dialog).getByRole("button", { name: "Publish only Site banner" })).toBeInTheDocument();
    });
  });
});
