import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { BannerScreen } from "./BannerScreen";
import type { SettingsState } from "./api";

const DOC: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [{ label: "Home", url: "https://www2.gov.bc.ca/" }],
});

const NOTHING_LIVE: SettingsState = { live: null, document: DOC, draft: null, baseRevision: null, errors: [] };

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
    await user.click(screen.getByRole("button", { name: "Publish" }));
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
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Draft saved, but it has problems to fix before it can be published.")).toBeInTheDocument();
    const message = screen.getByLabelText("Message");
    expect(message).toHaveAttribute("aria-invalid", "true");
    expect(message).toHaveAccessibleDescription(expect.stringContaining("Use plain text. Add links below instead of HTML."));
    const other = screen.getByRole("region", { name: "Other parts of the draft have problems that block publishing:" });
    expect(within(other).getByText("Footer: Must start with https:// or / (a page on this site).")).toBeInTheDocument();
  });

  it("a 409 shows the conflict panel; keeping mine rebases and says what it builds on", async () => {
    const live = { revision: 2, publishedAt: "2026-10-27T18:00:00.000Z", publishedBy: "Sam", note: null };
    const calls = stub(["NRMS.SiteEditor"], (c) => {
      if (c.url === "/nrms/api/site/settings/publish") return jsonResponse(409, { error: "published", code: "published", live, differing: ["banner"] });
      if (c.url === "/nrms/api/site/settings/rebase") return jsonResponse(200, { ...NOTHING_LIVE, live, baseRevision: 2, draft: { baseRevision: 2, updatedAt: live.publishedAt }, setAside: ["theme"] });
      return undefined;
    });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Publish" }));

    const panel = await screen.findByRole("region", { name: "Someone published while you were editing" });
    expect(within(panel).getByText(/^Revision 2 was published by Sam on .*\. Nothing of yours was published, and your draft is saved\.$/)).toBeInTheDocument();
    expect(within(panel).getByText("Your draft differs from it in: Banner.")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Someone published while you were editing" })).toHaveFocus();

    await user.click(within(panel).getByRole("button", { name: "Keep my banner, on top of their version" }));
    expect(await screen.findByText("Your banner changes now build on revision 2. Check them, then publish. Unpublished changes to Theme were set aside.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/nrms/api/site/settings/rebase")!.body).toMatchObject({ section: "banner" });
    expect(screen.queryByRole("region", { name: "Someone published while you were editing" })).toBeNull();
    expect(screen.getByText("Your banner changes now build on revision 2. Check them, then publish. Unpublished changes to Theme were set aside.")).toHaveFocus();
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
    await user.click(await screen.findByRole("button", { name: "Publish" }));
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
});
