import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { OrganizationsScreen } from "./OrganizationsScreen";

const ORGS = [
  {
    key: "health",
    displayName: "Health",
    abbreviation: "HLTH",
    isActive: true,
    isHq: false,
    isPublic: true,
    minister: { name: "Josie Osborne" },
  },
  {
    key: "gcpe-media-relations",
    displayName: "GCPE Media Relations",
    abbreviation: "GCPEMEDIA",
    isActive: true,
    isHq: true,
    isPublic: false,
    minister: { name: null },
  },
];

function stub(
  roles: string[],
  calls: { url: string; init?: RequestInit }[],
  orgs: unknown[] = ORGS,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session")
        return jsonResponse(200, {
          user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles },
          expiresAt: new Date().toISOString(),
        });
      if (url === "/core/api/organizations" && init?.method === "POST") {
        const created = {
          ...ORGS[0],
          key: "citizens-services",
          displayName: "Citizens' Services",
        };
        orgs = [...orgs, created];
        return jsonResponse(201, created);
      }
      if (url === "/core/api/organizations") return jsonResponse(200, orgs);
      if (
        url === "/core/api/organizations/health/deactivate" &&
        init?.method === "POST"
      )
        return new Response(null, { status: 204 });
      if (
        url === "/core/api/organizations/old/profile" &&
        init?.method === "PATCH"
      )
        return jsonResponse(200, { ...ORGS[0], key: "old", isActive: true });
      if (url === "/core/api/organizations/health/hq" && init?.method === "PUT")
        return jsonResponse(200, { ...ORGS[0], isHq: true });
      if (
        url === "/core/api/organizations/health/public" &&
        init?.method === "PUT"
      )
        return jsonResponse(200, { ...ORGS[0], isPublic: false });
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
    await waitFor(() =>
      expect(document.title).toBe("Organizations — GCPE News Staff"),
    );
    expect(
      await screen.findByLabelText(
        "GCPE Media Relations is an HQ organization",
      ),
    ).toBeChecked();
    const health = screen.getByLabelText("Health is an HQ organization");
    expect(health).not.toBeChecked();
    await userEvent.setup().click(health);
    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === "PUT")).toBe(true),
    );
    expect(
      JSON.parse(
        calls.find((c) => c.init?.method === "PUT")!.init!.body as string,
      ),
    ).toEqual({ isHq: true });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is now an HQ organization.",
    );
  });

  it("shows and sets whether each organization is listed publicly", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    expect(
      await screen.findByLabelText("GCPE Media Relations is listed publicly"),
    ).not.toBeChecked();
    const health = screen.getByLabelText("Health is listed publicly");
    expect(health).toBeChecked();
    await userEvent.setup().click(health);
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.endsWith("/public") && c.init?.method === "PUT",
        ),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        calls.find((c) => c.url.endsWith("/public"))!.init!.body as string,
      ),
    ).toEqual({ isPublic: false });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is no longer listed publicly.",
    );
  });

  it("a SiteEditor sees names, ministers and Edit buttons but no HQ/Public checkboxes", async () => {
    stub(["NRMS.SiteEditor"], []);
    renderScreen();
    expect(await screen.findByText("Josie Osborne")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Health" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "HQ" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Public" })).toBeNull();
  });

  it("Core.Admin sees the HQ and Public columns plus Minister and Edit", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    expect(
      await screen.findByRole("button", { name: "Edit Health" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Minister" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "HQ" }),
    ).toBeInTheDocument();
  });

  it("NRMS.Editor still gets the no-permission message", async () => {
    stub(["NRMS.Editor"], []);
    renderScreen();
    expect(
      await screen.findByText("You don’t have permission to view this page."),
    ).toBeInTheDocument();
  });

  it("is Core.Admin only", async () => {
    stub(["Calendar.SysAdmin"], []);
    renderScreen();
    expect(
      await screen.findByText("You don’t have permission to view this page."),
    ).toBeInTheDocument();
  });

  it("opens the form for a row, then returns focus to its Edit button on cancel", async () => {
    stub(["NRMS.SiteEditor"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Health" }),
    );
    expect(screen.getByRole("heading", { name: "Edit Health" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Health" })).toHaveFocus();
  });

  it("Add ministry creates it and opens it for editing", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Add ministry" }),
    );
    await user.type(
      screen.getByLabelText(/Ministry name/),
      "Citizens' Services",
    );
    await user.click(screen.getByRole("button", { name: "Create ministry" }));
    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === "POST")).toBe(true),
    );
    expect(
      await screen.findByRole("form", { name: "Edit Citizens' Services" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add a ministry" })).toBeNull();
  });

  it("Deactivate asks in-page first, then posts", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    expect(
      screen.getByText(
        "Deactivate Health? It disappears from the public site, and its subscribers stop receiving news. This can be undone with Reactivate, but subscribers are not moved to another ministry.",
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === "/core/api/organizations/health/deactivate" &&
            c.init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is deactivated.",
    );
  });

  it("Cancel on the Deactivate prompt posts nothing", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
  });

  it("inactive rows show Reactivate, which sends isActive: true", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
    ]);
    renderScreen();
    const user = userEvent.setup();
    expect(
      screen.queryByRole("button", { name: "Deactivate Old Ministry" }),
    ).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: "Reactivate Old Ministry" }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.endsWith("/old/profile") && c.init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        calls.find((c) => c.url.endsWith("/old/profile"))!.init!.body as string,
      ),
    ).toEqual({ isActive: true });
  });

  it("SiteEditor sees neither Add nor Deactivate/Reactivate", async () => {
    stub(
      ["NRMS.SiteEditor"],
      [],
      [
        ORGS[0],
        {
          ...ORGS[0],
          key: "old",
          displayName: "Old Ministry",
          isActive: false,
        },
      ],
    );
    renderScreen();
    await screen.findByRole("button", { name: "Edit Health" });
    expect(screen.queryByRole("button", { name: "Add ministry" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deactivate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reactivate/ })).toBeNull();
  });
});
