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
import { BANNER_MESSAGE_HINT, BIRTH_DATE_HINT, DESCRIPTION_HINT, OPERATOR_NOTE, READ_ONLY_NOTE, SiteIdentityScreen, TWITTER_HINT } from "./SiteIdentityScreen";

const BASE: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});
const IDENTITY: SiteSettings["siteIdentity"] = {
  description: "News from the Province of British Columbia.",
  twitterSite: "@BCGovNews",
  blueBridge: { message: "ALERT: the King has passed away at the age of {age}.", birthDate: "1948-11-14" },
};
const DOC: SiteSettings = { ...BASE, siteIdentity: IDENTITY };

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

function stub(roles: string[], initial: SettingsState, publishResponse?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url === "/nrms/api/site/settings" && call.method === "GET") return jsonResponse(200, initial);
      if (url === "/nrms/api/site/settings/publish" && call.method === "POST") return publishResponse ? publishResponse() : jsonResponse(200, { revision: 5, state: initial });
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
            <SiteIdentityScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("SiteIdentityScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("loads the published siteIdentity and shows the four fields with the BC values", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByRole("heading", { name: "Site identity", level: 1 });
    expect(await screen.findByLabelText("Site description")).toHaveValue(IDENTITY.description);
    expect(screen.getByLabelText("X (Twitter) account")).toHaveValue("@BCGovNews");
    const bridge = screen.getByRole("group", { name: "Project Blue Bridge banner" });
    expect(within(bridge).getByLabelText("Banner message")).toHaveValue(IDENTITY.blueBridge.message);
    const birth = within(bridge).getByLabelText("Birth date");
    expect(birth).toHaveValue("1948-11-14");
    expect(birth).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Site description")).toHaveAccessibleDescription(DESCRIPTION_HINT);
    expect(screen.getByLabelText("X (Twitter) account")).toHaveAccessibleDescription(TWITTER_HINT);
    expect(within(bridge).getByLabelText("Banner message")).toHaveAccessibleDescription(BANNER_MESSAGE_HINT);
    expect(birth).toHaveAccessibleDescription(BIRTH_DATE_HINT);
    expect(screen.getByText("The site name and the BC logo are set by the operator, not here.")).toBeInTheDocument();
    expect(OPERATOR_NOTE).toBe("The site name and the BC logo are set by the operator, not here.");
    await waitFor(() => expect(document.title).toBe("Site identity — GCPE News Staff"));
  });

  it("editing the description and saving sends the whole siteIdentity section", async () => {
    const calls = stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    const user = userEvent.setup();
    const description = await screen.findByLabelText("Site description");
    await user.clear(description);
    await user.type(description, "Updated description");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/settings/publish")).toBe(true));
    const body = calls.find((c) => c.url === "/nrms/api/site/settings/publish")!.body as { section: string; baseRevision: number; value: SiteSettings["siteIdentity"] };
    expect(body.section).toBe("siteIdentity");
    expect(body.baseRevision).toBe(4);
    expect(body.value).toEqual({ ...IDENTITY, description: "Updated description" });
    expect(await screen.findByRole("status")).toHaveTextContent("Published revision 5");
  });

  it("a server error on siteIdentity.blueBridge.message shows beside Banner message and tied to it", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC, [{ field: "siteIdentity.blueBridge.message", message: "The only placeholder is {age}." }]));
    renderScreen();
    const bridge = await screen.findByRole("group", { name: "Project Blue Bridge banner" });
    const message = within(bridge).getByLabelText("Banner message");
    expect(message).toBeInvalid();
    expect(message).toHaveAccessibleDescription(`${BANNER_MESSAGE_HINT} The only placeholder is {age}.`);
    expect(within(bridge).getByLabelText("Birth date")).toBeValid();
  });

  it("a field with two server errors shows both", async () => {
    stub(
      ["NRMS.SiteEditor"],
      stateOf(DOC, [
        { field: "siteIdentity.blueBridge.message", message: "Use plain text." },
        { field: "siteIdentity.blueBridge.message", message: "The only placeholder is {age}." },
      ]),
    );
    renderScreen();
    expect(await screen.findByLabelText("Banner message")).toHaveAccessibleDescription(`${BANNER_MESSAGE_HINT} Use plain text. The only placeholder is {age}.`);
  });

  it("every field shows its own server message, tied to the field", async () => {
    stub(
      ["NRMS.SiteEditor"],
      stateOf(DOC, [
        { field: "siteIdentity.description", message: "Use plain text." },
        { field: "siteIdentity.twitterSite", message: "Enter an X account like @BCGovNews." },
        { field: "siteIdentity.blueBridge.birthDate", message: "Enter a date like 1948-11-14." },
      ]),
    );
    renderScreen();
    expect(await screen.findByLabelText("Site description")).toHaveAccessibleDescription(`${DESCRIPTION_HINT} Use plain text.`);
    expect(screen.getByLabelText("X (Twitter) account")).toHaveAccessibleDescription(`${TWITTER_HINT} Enter an X account like @BCGovNews.`);
    expect(screen.getByLabelText("Birth date")).toHaveAccessibleDescription(`${BIRTH_DATE_HINT} Enter a date like 1948-11-14.`);
  });

  it("a refused publish moves focus to the first invalid field", async () => {
    const errors = [
      { field: "siteIdentity.twitterSite", message: "Enter an X account like @BCGovNews." },
      { field: "siteIdentity.blueBridge.message", message: "Enter some text." },
    ];
    stub(["NRMS.SiteEditor"], stateOf(DOC), () => jsonResponse(422, { error: "invalid", fieldErrors: errors }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByLabelText("X (Twitter) account")).toHaveFocus());
  });

  it("a Core.Admin without NRMS.SiteEditor sees the fields disabled and no write buttons", async () => {
    stub(["Core.Admin"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByLabelText("Site description")).toBeDisabled();
    expect(screen.getByLabelText("X (Twitter) account")).toBeDisabled();
    expect(screen.getByLabelText("Banner message")).toBeDisabled();
    expect(screen.getByLabelText("Birth date")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByText(READ_ONLY_NOTE)).toBeInTheDocument();
  });

  it("a Site Editor does not see the read-only line", async () => {
    stub(["NRMS.SiteEditor"], stateOf(DOC));
    renderScreen();
    await screen.findByLabelText("Site description");
    expect(screen.queryByText(READ_ONLY_NOTE)).toBeNull();
  });

  it("other roles are told they cannot view it", async () => {
    stub(["NRMS.Author"], stateOf(DOC));
    renderScreen();
    expect(await screen.findByText(/don.t have permission/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Site description")).toBeNull();
  });
});
