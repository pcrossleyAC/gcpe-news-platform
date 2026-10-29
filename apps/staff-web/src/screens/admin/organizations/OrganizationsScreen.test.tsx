import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { OrganizationsScreen } from "./OrganizationsScreen";

/** Unavailable to the user: natively disabled, or a BC button that is busy (aria-disabled, still focusable). */
function expectUnavailable(el: HTMLElement): void {
  expect(el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true").toBe(true);
}

const ORGS = [
  {
    key: "health",
    displayName: "Health",
    abbreviation: "HLTH",
    isActive: true,
    isHq: false,
    isPublic: true,
    minister: { name: "Josie Osborne" },
    url: null,
    social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [],
    serviceLinks: [],
  },
  {
    key: "gcpe-media-relations",
    displayName: "GCPE Media Relations",
    abbreviation: "GCPEMEDIA",
    isActive: true,
    isHq: true,
    isPublic: false,
    minister: { name: null },
    url: null,
    social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [],
    serviceLinks: [],
  },
];

let failures: Record<string, () => Response> = {};

function stub(
  roles: string[],
  calls: { url: string; init?: RequestInit }[],
  orgs: unknown[] = ORGS,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const failure = failures[`${init?.method ?? "GET"} ${url}`];
      if (failure) return failure();
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
      ) {
        orgs = (orgs as typeof ORGS).map((o) =>
          o.key === "health" ? { ...o, isActive: false } : o,
        );
        return new Response(null, { status: 204 });
      }
      if (
        url === "/core/api/organizations/old/profile" &&
        init?.method === "PATCH"
      ) {
        orgs = (orgs as typeof ORGS).map((o) =>
          o.key === "old" ? { ...o, isActive: true } : o,
        );
        return jsonResponse(200, {
          ...(orgs as typeof ORGS).find((o) => o.key === "old"),
        });
      }
      if (
        url === "/core/api/organizations/health/profile" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(init.body as string) as { isActive?: boolean };
        orgs = (orgs as typeof ORGS).map((o) =>
          o.key === "health" ? { ...o, ...body } : o,
        );
        return jsonResponse(200, { ...ORGS[0], ...body });
      }
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

const showInactive = async () =>
  userEvent.setup().click(
    await screen.findByRole("checkbox", {
      name: /Show inactive organizations/,
    }),
  );

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
    failures = {};
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
    expect(screen.queryByRole("link", { name: "Cabinet change" })).toBeNull();
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
    expect(
      screen.getByRole("link", { name: "Cabinet change" }),
    ).toHaveAttribute("href", "/organizations/cabinet-change");
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
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
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
    expect(screen.queryByRole("form", { name: "Deactivate Health" })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
  });

  it("inactive rows show Reactivate, which sends isActive: true", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
    ]);
    renderScreen();
    await showInactive();
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

  it("closes an open edit form when its row is deactivated", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Health" }),
    );
    expect(
      screen.getByRole("form", { name: "Edit Health" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deactivate Health" }));
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is deactivated.",
    );
    expect(screen.queryByRole("form", { name: "Edit Health" })).toBeNull();
  });

  it("closes an open edit form when its row is reactivated", async () => {
    stub(
      ["Core.Admin"],
      [],
      [
        {
          ...ORGS[0],
          key: "old",
          displayName: "Old Ministry",
          isActive: false,
        },
      ],
    );
    renderScreen();
    await showInactive();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Old Ministry" }),
    );
    expect(
      screen.getByRole("form", { name: "Edit Old Ministry" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Reactivate Old Ministry" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Old Ministry is active again.",
    );
    expect(
      screen.queryByRole("form", { name: "Edit Old Ministry" }),
    ).toBeNull();
  });

  it("keeps another row's edit form open when a different row is deactivated", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit GCPE Media Relations" }),
    );
    await user.click(screen.getByRole("button", { name: "Deactivate Health" }));
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is deactivated.",
    );
    expect(
      screen.getByRole("form", { name: "Edit GCPE Media Relations" }),
    ).toBeInTheDocument();
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
    await showInactive();
    await screen.findByRole("button", { name: "Edit Old Ministry" });
    expect(screen.queryByRole("button", { name: "Add ministry" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deactivate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reactivate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set successor/ })).toBeNull();
  });

  it("moves focus into the Deactivate prompt, and back to Deactivate on Cancel", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    expect(
      screen.getByRole("heading", { name: "Deactivate Health" }),
    ).toHaveFocus();
    expect(
      within(screen.getByRole("form", { name: "Deactivate Health" })).getByText(
        /subscribers are not moved/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Deactivate Health" }),
    ).toHaveFocus();
  });

  it("with inactive shown, returns focus to the row's Edit button after Deactivate succeeds", async () => {
    stub(
      ["Core.Admin"],
      [],
      [
        ...ORGS,
        {
          ...ORGS[0],
          key: "old",
          displayName: "Old Ministry",
          isActive: false,
        },
      ],
    );
    renderScreen();
    await showInactive();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    await screen.findByText(/Health is deactivated\./);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit Health" })).toHaveFocus(),
    );
  });

  describe("inactive organizations", () => {
    const WITH_INACTIVE = [
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
      ...ORGS,
    ];
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        // The name cell's text, without the "Not public" note (its own test is below).
        .map((r) =>
          within(r)
            .getAllByRole("cell")[0]!
            .textContent!.replace(/\s*Not public$/, ""),
        );

    it("are hidden by default, with a count on the toggle", async () => {
      stub(["Core.Admin"], [], WITH_INACTIVE);
      renderScreen();
      await screen.findByRole("button", { name: "Edit Health" });
      expect(rowNames()).toEqual(["Health", "GCPE Media Relations"]);
      expect(
        screen.getByRole("checkbox", {
          name: "Show inactive organizations (1)",
        }),
      ).not.toBeChecked();
    });

    it("are listed after every active one when shown, and hidden again when unticked", async () => {
      stub(["NRMS.SiteEditor"], [], WITH_INACTIVE);
      renderScreen();
      await showInactive();
      expect(rowNames()).toEqual([
        "Health",
        "GCPE Media Relations",
        "Old Ministry",
      ]);
      await showInactive();
      expect(rowNames()).toEqual(["Health", "GCPE Media Relations"]);
    });

    it("has no toggle when every organization is active", async () => {
      stub(["Core.Admin"], []);
      renderScreen();
      await screen.findByRole("button", { name: "Edit Health" });
      expect(
        screen.queryByRole("checkbox", { name: /Show inactive organizations/ }),
      ).toBeNull();
    });

    it("a row deactivated while inactive ones are hidden leaves the list, and focus goes to the toggle", async () => {
      stub(["Core.Admin"], []);
      renderScreen();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Deactivate Health" }),
      );
      await user.click(screen.getByRole("button", { name: "Deactivate" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Health is deactivated. Inactive organizations are hidden: tick Show inactive organizations to see it.",
      );
      const toggle = await screen.findByRole("checkbox", {
        name: "Show inactive organizations (1)",
      });
      await waitFor(() => expect(toggle).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Edit Health" })).toBeNull();
    });

    it("a row saved as inactive from the edit form leaves the list, and focus goes to the toggle", async () => {
      // The edit form needs a whole record (a sortOrder, or Save stays disabled).
      stub(
        ["Core.Admin"],
        [],
        [{ ...ORGS[0], sortOrder: 1, parentKey: null }, ORGS[1]],
      );
      renderScreen();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Edit Health" }),
      );
      await user.click(screen.getByRole("checkbox", { name: "Active" }));
      await user.click(screen.getByRole("button", { name: "Save" }));
      const toggle = await screen.findByRole("checkbox", {
        name: "Show inactive organizations (1)",
      });
      await waitFor(() => expect(toggle).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Edit Health" })).toBeNull();
    });
  });

  it("returns focus to the row's Edit button after Reactivate succeeds", async () => {
    stub(
      ["Core.Admin"],
      [],
      [
        {
          ...ORGS[0],
          key: "old",
          displayName: "Old Ministry",
          isActive: false,
        },
      ],
    );
    renderScreen();
    await showInactive();
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Reactivate Old Ministry" }),
      );
    await screen.findByText("Old Ministry is active again.");
    expect(
      screen.getByRole("button", { name: "Edit Old Ministry" }),
    ).toHaveFocus();
  });

  describe("not-public hint", () => {
    const OLD_HIDDEN = {
      ...ORGS[0],
      key: "old",
      displayName: "Old Ministry",
      isActive: false,
      isPublic: false,
    };

    it("reactivating a non-public ministry says it isn't public", async () => {
      stub(["Core.Admin"], [], [OLD_HIDDEN]);
      renderScreen();
      await showInactive();
      await userEvent
        .setup()
        .click(
          await screen.findByRole("button", {
            name: "Reactivate Old Ministry",
          }),
        );
      expect(await screen.findByRole("status")).toHaveTextContent(
        /^Old Ministry is active again\. It isn't public: tick Public to list it on the public site\.$/,
      );
    });

    it("reactivating a public ministry keeps the plain status", async () => {
      stub(["Core.Admin"], [], [{ ...OLD_HIDDEN, isPublic: true }]);
      renderScreen();
      await showInactive();
      await userEvent
        .setup()
        .click(
          await screen.findByRole("button", {
            name: "Reactivate Old Ministry",
          }),
        );
      expect(await screen.findByRole("status")).toHaveTextContent(
        /^Old Ministry is active again\.$/,
      );
    });

    for (const role of ["NRMS.SiteEditor", "Core.Admin"]) {
      it(`a non-public row shows "Not public" beside its name to ${role}`, async () => {
        stub([role], []);
        renderScreen();
        const media = (
          await screen.findByText("GCPE Media Relations")
        ).closest("td")!;
        expect(media).toHaveTextContent(/^GCPE Media Relations\s*Not public$/);
        const health = screen.getByText("Health").closest("td")!;
        expect(health).not.toHaveTextContent("Not public");
      });
    }
  });

  it("Deactivate 404 keeps the prompt open with the error inside it", async () => {
    failures["POST /core/api/organizations/health/deactivate"] = () =>
      jsonResponse(404, { error: "not found" });
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    const form = screen.getByRole("form", { name: "Deactivate Health" });
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent(/not found/i);
    expect(screen.getByRole("button", { name: "Deactivate" })).toHaveFocus();
  });

  it("Reactivate network error shows an alert in the row and keeps focus on the button", async () => {
    failures["PATCH /core/api/organizations/old/profile"] = () => {
      throw new TypeError("network down");
    };
    stub(
      ["Core.Admin"],
      [],
      [
        {
          ...ORGS[0],
          key: "old",
          displayName: "Old Ministry",
          isActive: false,
        },
      ],
    );
    renderScreen();
    await showInactive();
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Reactivate Old Ministry" }),
      );
    const alert = await screen.findByRole("alert");
    expect(alert.closest("tr")).toHaveTextContent("Old Ministry");
    expect(
      screen.getByRole("button", { name: "Reactivate Old Ministry" }),
    ).toHaveFocus();
  });

  it("Add 400 shows the server's message inside the add form", async () => {
    failures["POST /core/api/organizations"] = () =>
      jsonResponse(400, {
        error: "invalid request",
        issues: [{ message: "Name is too long." }],
      });
    stub(["Core.Admin"], []);
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
    const form = screen.getByRole("form", { name: "Add a ministry" });
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Name is too long.",
    );
    expect(
      screen.getByRole("button", { name: "Create ministry" }),
    ).toHaveFocus();
  });
  it("Deactivate opens the hand-over panel; handing over posts succeed and says where pages go", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    failures["POST /core/api/organizations/health/succeed"] = () =>
      jsonResponse(200, { ...ORGS[0], isActive: false, successorKeys: ["gcpe-media-relations"] });
    stub(["Core.Admin"], calls);
    renderScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deactivate Health" }),
    );
    const form = screen.getByRole("form", { name: "Deactivate Health" });
    await user.selectOptions(
      within(form).getByLabelText("Has a successor?"),
      "GCPE Media Relations",
    );
    // The test stub answers no count URL: every count is unavailable, and the hand-over still goes.
    expect(
      await within(form).findByRole("checkbox", { name: /subscribers.*count unavailable/ }),
    ).toBeChecked();
    await user.click(
      within(form).getByRole("button", { name: "Deactivate and hand over" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Health is deactivated. Its pages now send visitors to GCPE Media Relations. Moves to other services finish shortly.",
    );
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
    expect(
      JSON.parse(
        calls.find((c) => c.url.endsWith("/health/succeed"))!.init!.body as string,
      ),
    ).toMatchObject({ successorKeys: ["gcpe-media-relations"] });
    expect(screen.queryByRole("form", { name: "Deactivate Health" })).toBeNull();
  });

  it("an inactive row gets Set successor…, which opens the panel without deactivating", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    failures["POST /core/api/organizations/old/succeed"] = () =>
      jsonResponse(200, { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false });
    stub(["Core.Admin"], calls, [
      ...ORGS,
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
    ]);
    renderScreen();
    await showInactive();
    const user = userEvent.setup();
    const open = await screen.findByRole("button", {
      name: "Set successor for Old Ministry",
    });
    expect(open).toHaveTextContent("Set successor…");
    await user.click(open);
    const form = screen.getByRole("form", { name: "Set successor for Old Ministry" });
    await user.selectOptions(within(form).getByLabelText("Successor"), "Health");
    await user.click(within(form).getByRole("button", { name: "Set successor" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Old Ministry is deactivated. Its pages now send visitors to Health.",
    );
    expect(calls.some((c) => c.url.endsWith("/old/succeed"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit Old Ministry" })).toHaveFocus(),
    );
  });

  it("Cancel on Set successor returns focus to its button", async () => {
    stub(["Core.Admin"], [], [
      ...ORGS,
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
    ]);
    renderScreen();
    await showInactive();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Set successor for Old Ministry" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Set successor for Old Ministry" }),
    ).toHaveFocus();
  });

  it("Reactivate 409 says another active ministry holds the abbreviation", async () => {
    failures["PATCH /core/api/organizations/old/profile"] = () =>
      jsonResponse(409, { error: "abbreviation-taken", takenBy: "Health" });
    stub(["Core.Admin"], [], [
      ORGS[0],
      { ...ORGS[0], key: "old", displayName: "Old Ministry", abbreviation: "HLTH", isActive: false },
    ]);
    renderScreen();
    await showInactive();
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Reactivate Old Ministry" }),
      );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Old Ministry can't be reactivated while Health uses its abbreviation HLTH. Give one of them a different abbreviation first.",
    );
    expect(alert.closest("tr")).toHaveTextContent("Old Ministry");
  });
  it("while the hand-over saves, the other row actions wait", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    failures["POST /core/api/organizations/health/deactivate"] = () => {
      throw new Error("replaced below");
    };
    stub(["Core.Admin"], [], [
      ...ORGS,
      { ...ORGS[0], key: "old", displayName: "Old Ministry", isActive: false },
    ]);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = fetchMock.getMockImplementation()! as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health/deactivate")) {
        await pending;
        return new Response(null, { status: 204 });
      }
      return inner(url, init);
    });
    renderScreen();
    await showInactive();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Health" }));
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    expectUnavailable(screen.getByRole("button", { name: "Deactivate GCPE Media Relations" }));
    expectUnavailable(screen.getByRole("button", { name: "Set successor for Old Ministry" }));
    expectUnavailable(screen.getByRole("button", { name: "Reactivate Old Ministry" }));
    expectUnavailable(screen.getByRole("button", { name: "Cancel" }));
    expectUnavailable(screen.getByRole("button", { name: "Add ministry" }));
    expectUnavailable(screen.getByRole("button", { name: "Edit Health" }));
    expectUnavailable(screen.getByRole("button", { name: "Edit Old Ministry" }));
    release();
    expect(await screen.findByRole("status")).toHaveTextContent("Health is deactivated.");
    expect(screen.getByRole("button", { name: "Reactivate Old Ministry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add ministry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit Old Ministry" })).toBeEnabled();
  });
});
