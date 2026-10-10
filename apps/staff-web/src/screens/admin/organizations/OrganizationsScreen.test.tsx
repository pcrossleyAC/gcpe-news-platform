import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { OrganizationsScreen } from "./OrganizationsScreen";

const ORGS = [
  { key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false },
  { key: "gcpe-media-relations", displayName: "GCPE Media Relations", abbreviation: "GCPEMEDIA", isActive: true, isHq: true },
];

function stub(roles: string[], calls: { url: string; init?: RequestInit }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (url === "/core/api/organizations/health/hq" && init?.method === "PUT") return jsonResponse(200, { ...ORGS[0], isHq: true });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <OrganizationsScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("OrganizationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each organization's HQ flag and sets it", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    await waitFor(() => expect(document.title).toBe("Organizations — GCPE News Staff"));
    expect(await screen.findByLabelText("GCPE Media Relations is an HQ organization")).toBeChecked();
    const health = screen.getByLabelText("Health is an HQ organization");
    expect(health).not.toBeChecked();
    await userEvent.setup().click(health);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "PUT")!.init!.body as string)).toEqual({ isHq: true });
    expect(await screen.findByRole("status")).toHaveTextContent("Health is now an HQ organization.");
  });

  it("is Core.Admin only", async () => {
    stub(["Calendar.SysAdmin"], []);
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
  });
});
