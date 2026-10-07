import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { BlueBridgeScreen } from "./BlueBridgeScreen";
import type { BlueBridgeView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const OFF: BlueBridgeView = { on: false, version: 1, updatedAt: null, warning: "Do not click OK unless you have approval from IGRS" };

function stubConfig(isTestSite: boolean) {
  return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite });
}

describe("BlueBridgeScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return stubConfig(false);
        if (url === "/nrms/api/site/blue-bridge") return jsonResponse(200, OFF);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<BlueBridgeScreen />));
    await screen.findByRole("heading", { name: "Project Blue Bridge", level: 1 });
    await waitFor(() => expect(document.title).toBe("Project Blue Bridge — GCPE News Staff"));
  });

  it("shows the switch to Core.Admin, with the confirm button disabled until the phrase and checkbox both match", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return stubConfig(false);
        if (url === "/nrms/api/site/blue-bridge" && (init?.method ?? "GET") === "GET") return jsonResponse(200, OFF);
        if (url === "/nrms/api/site/blue-bridge" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          return jsonResponse(200, { ...OFF, on: body.on, version: 2 });
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<BlueBridgeScreen />));
    await screen.findByText("Do not click OK unless you have approval from IGRS");
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "Project Blue Bridge" }));

    const dialog = await screen.findByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Confirm turn on" });
    expect(confirmButton).toBeDisabled();

    // Wrong case: stays disabled.
    const phraseField = within(dialog).getByLabelText("Type KING CHARLES III to confirm");
    await user.type(phraseField, "king charles iii");
    await user.click(within(dialog).getByRole("checkbox", { name: "IGRS has approved this change" }));
    expect(confirmButton).toBeDisabled();

    await user.clear(phraseField);
    await user.type(phraseField, "KING CHARLES III");
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/blue-bridge" && c.init?.method === "PUT")).toBe(true));
    const putCall = calls.find((c) => c.url === "/nrms/api/site/blue-bridge" && c.init?.method === "PUT")!;
    expect(JSON.parse(putCall.init!.body as string)).toEqual({ version: 1, on: true, confirmation: "KING CHARLES III", acknowledgeIgrs: true });
  });

  it("a non-admin (e.g. NRMS.SiteEditor) sees no switch, only the read-only state and warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return stubConfig(false);
        if (url === "/nrms/api/site/blue-bridge") return jsonResponse(200, OFF);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<BlueBridgeScreen />));
    await screen.findByText("Do not click OK unless you have approval from IGRS");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Project Blue Bridge is currently OFF.")).toBeInTheDocument();
  });

  it("shows a TEST site notice when config.isTestSite is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return stubConfig(true);
        if (url === "/nrms/api/site/blue-bridge") return jsonResponse(200, OFF);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<BlueBridgeScreen />));
    expect(await screen.findByText("This is a TEST site.")).toBeInTheDocument();
  });
});
