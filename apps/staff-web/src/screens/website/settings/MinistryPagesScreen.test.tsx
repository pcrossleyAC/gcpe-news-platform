import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { MinistryPagesScreen } from "./MinistryPagesScreen";
import type { SettingsState } from "./api";

const TENANT: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});
const DOC: SiteSettings = { ...TENANT, ministryPages: { ...TENANT.ministryPages, mediaContacts: "Who to call" } };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(roles: string[], handler: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const initial: SettingsState = { live: { revision: 4, publishedAt: "2026-10-20T17:30:00.000Z", publishedBy: "Sam", note: null }, document: DOC, draft: null, baseRevision: 4, errors: [] };
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
            <MinistryPagesScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("MinistryPagesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows seven labelled fields with the current headings; h1 and title are 'Ministry page headings'", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    await screen.findByRole("heading", { name: "Ministry page headings", level: 1 });
    expect(await screen.findByLabelText("More from this Ministry heading")).toHaveValue("More from this Ministry");
    expect(screen.getByLabelText("Media contacts heading")).toHaveValue("Who to call");
    expect(screen.getAllByRole("textbox")).toHaveLength(8); // seven headings + the history note
    for (const label of ["Ministry website heading", "Ministry photos heading", "Ministry videos heading", "Featured topics heading", "Featured services heading"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    await waitFor(() => expect(document.title).toBe("Ministry page headings — GCPE News Staff"));
  });

  it("publishing sends only section ministryPages", async () => {
    const calls = stub(["NRMS.SiteEditor"], (c) => (c.url.endsWith("/publish") ? jsonResponse(200, { revision: 5, state: { live: null, document: DOC, draft: null, baseRevision: 5, errors: [] } }) : undefined));
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Ministry photos heading");
    await user.clear(field);
    await user.type(field, "Photos");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/publish"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/publish"))!.body).toEqual({ baseRevision: 4, section: "ministryPages", value: { ...DOC.ministryPages, ministryPhotos: "Photos" } });
  });

  it("Reset to defaults fills the form only", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByLabelText("Media contacts heading");
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(await screen.findByText("Headings reset to the defaults. Save or publish to keep them.")).toBeInTheDocument();
    expect(screen.getByLabelText("Media contacts heading")).toHaveValue("Media Contacts");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a blank heading shows 'Enter a heading.' under it", async () => {
    stub(["NRMS.SiteEditor"], (c) =>
      c.url.endsWith("/publish")
        ? jsonResponse(422, { errors: ["ministryPages.ministryVideos: Enter a heading."], fieldErrors: [{ field: "ministryPages.ministryVideos", message: "Enter a heading." }] })
        : undefined,
    );
    renderScreen();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Ministry videos heading");
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByLabelText("Ministry videos heading")).toHaveAccessibleDescription("Enter a heading."));
    expect(screen.getByLabelText("Ministry videos heading")).toBeInvalid();
  });

  it("Core.Admin alone sees the headings read-only", async () => {
    stub(["Core.Admin"]);
    renderScreen();
    expect(await screen.findByLabelText("Media contacts heading")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});
