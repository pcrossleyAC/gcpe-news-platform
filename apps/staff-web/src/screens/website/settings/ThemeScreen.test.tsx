import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { ThemeScreen } from "./ThemeScreen";
import type { SettingsState } from "./api";

const COLORS = { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" };
const TENANT: SiteSettings = defaultSiteSettings({ colors: COLORS, footerLinks: [] });
const DOC: SiteSettings = { ...TENANT, theme: { colors: { ...TENANT.theme.colors, primary: "#1A5A96", bannerInfo: "#8899AA" } } };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(roles: string[], handler: (call: Call) => Response | undefined = () => undefined, document: SiteSettings = DOC) {
  const calls: Call[] = [];
  const initial: SettingsState = { live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null }, document, draft: null, baseRevision: 4, errors: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      const handled = handler(call);
      if (handled) return handled;
      if (url === "/nrms/api/site/settings" && call.method === "GET") return jsonResponse(200, initial);
      if (url === "/nrms/api/site/settings/defaults" && call.method === "GET") return jsonResponse(200, TENANT);
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
            <ThemeScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("ThemeScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows a labelled hex input per colour, with readable / too faint badges; h1 and title are 'Theme colours'", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    await screen.findByRole("heading", { name: "Theme colours", level: 1 });
    expect(await screen.findByLabelText("Header and buttons")).toHaveValue("#1A5A96");
    expect(screen.getByLabelText("Header and buttons colour picker")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/colour picker$/)).toHaveLength(11);
    expect(screen.getByLabelText("Information banner")).toHaveAccessibleDescription(/Too faint 2\.9:1/);
    expect(screen.getByLabelText("Header and buttons")).toHaveAccessibleDescription(/Readable 7\.\d:1/);
    await waitFor(() => expect(document.title).toBe("Theme colours — GCPE News Staff"));
  });

  it("shows the badge for the pair a colour belongs to, and updates it as the hex is typed", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Information banner");
    await user.clear(field);
    await user.type(field, "#013366");
    expect(field).toHaveAccessibleDescription(/Readable 12\.6:1/);
    expect(screen.getByLabelText("Page background")).toHaveAccessibleDescription(/Readable 13\.\d:1/);
  });

  it("a pale primary with dark header text shows the server's link-text and white-text checks, not just 'Readable on the header'", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    const text = await screen.findByLabelText("Text on the header and buttons");
    await user.clear(text);
    await user.type(text, "#000000");
    const primary = screen.getByLabelText("Header and buttons");
    await user.clear(primary);
    await user.type(primary, "#8FB3E8");
    expect(primary).toHaveAccessibleDescription(/Readable \d+\.\d:1 on the header/);
    expect(primary).toHaveAccessibleDescription(/Too faint 2\.1:1 as link text/);
    expect(primary).toHaveAccessibleDescription(/Too faint 2\.1:1 behind white text/);
    expect(screen.getByLabelText("Page background")).toHaveAccessibleDescription(/Too faint 2\.1:1 as link text/);
  });

  it("publishing '#1a5a96' sends '#1A5A96' for the theme section only", async () => {
    const calls = stub(["NRMS.SiteEditor"], (c) => (c.url.endsWith("/publish") ? jsonResponse(200, { revision: 5, state: { live: null, document: DOC, draft: null, baseRevision: 5, errors: [] } }) : undefined));
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Header and buttons");
    await user.clear(field);
    await user.type(field, "#1a5a96");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const post = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!;
    expect(post.body).toMatchObject({ baseRevision: 4, section: "theme", value: { colors: { ...DOC.theme.colors, primary: "#1A5A96" } } });
  });

  it("Reset to defaults fills the form only and says so", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Header and buttons");
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(await screen.findByText("Colours reset to the defaults. Save or publish to keep them.")).toBeInTheDocument();
    expect(screen.getByLabelText("Header and buttons")).toHaveValue("#013366");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a 422 contrast error shows under that colour", async () => {
    const message = "Too faint to read behind white text (3.1:1, needs 4.5:1). Pick a darker shade.";
    stub(["NRMS.SiteEditor"], (c) =>
      c.url.endsWith("/publish")
        ? jsonResponse(422, { errors: [`theme.colors.bannerInfo: ${message}`], fieldErrors: [{ field: "theme.colors.bannerInfo", message }] })
        : undefined,
    );
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Information banner");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const field = await screen.findByLabelText("Information banner");
    await waitFor(() => expect(field).toHaveAccessibleDescription(new RegExp(message.slice(0, 30))));
    expect(field).toBeInvalid();
  });

  it("the preview uses the colours being edited, banner strips included", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Emergency banner");
    await user.clear(field);
    await user.type(field, "#112233");
    expect(screen.getByTestId("preview-emergency")).toHaveStyle({ background: "#112233" });
    expect(screen.getByTestId("preview-info")).toHaveStyle({ background: "#8899AA" });
  });

  it("edits the Connect section-bar colour: labelled, hinted, badged, previewed and sent", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Section bar colour (Connect page)");
    expect(field).toHaveValue("#2B5580");
    expect(field).toHaveAccessibleDescription(/Connect page/);
    expect(field).toHaveAccessibleDescription(/Readable/);
    await user.clear(field);
    await user.type(field, "#f08080");
    expect(screen.getByTestId("preview-section-bar")).toHaveStyle({ background: "#f08080" });
    expect(field).toHaveAccessibleDescription(/Too faint/);
    await user.clear(field);
    await user.type(field, "#112233");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.method !== "GET" && JSON.stringify(c.body).includes('"sectionBar":"#112233"'))).toBe(true));
  });

  it("Core.Admin alone sees the colours but no buttons to change them", async () => {
    stub(["Core.Admin"]);
    renderScreen();
    expect(await screen.findByLabelText("Header and buttons")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });
});
