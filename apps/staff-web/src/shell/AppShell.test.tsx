import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { AppShell } from "./AppShell";

function stubSession(roles: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") {
        return new Response(JSON.stringify({ user: { id: "1", name: "Pat", email: "pat@example.invalid", roles }, expiresAt: new Date().toISOString() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function renderShell(roles: string[]) {
  stubSession(roles);
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/"]}>
        <AppShell />
      </MemoryRouter>
    </SessionProvider>,
  );
  await waitFor(() => expect(screen.getByText("Signed in as Pat")).toBeInTheDocument());
}

const allLabels = ["Releases", "Search", "Website", "Users", "Error log"];
const visibleLabels = () => allLabels.filter((label) => screen.queryByRole("link", { name: label }) !== null);

describe("AppShell nav — roles decide what's shown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a viewer sees Releases + Search only", async () => {
    await renderShell(["NRMS.Viewer"]);
    expect(visibleLabels()).toEqual(["Releases", "Search"]);
  });

  it("a site editor also sees Website", async () => {
    await renderShell(["NRMS.SiteEditor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website"]);
  });

  it("Core.Admin sees Website (to reach Project Blue Bridge), Users and the error log", async () => {
    await renderShell(["Core.Admin"]);
    expect(visibleLabels()).toEqual(["Website", "Users", "Error log"]);
  });
});
