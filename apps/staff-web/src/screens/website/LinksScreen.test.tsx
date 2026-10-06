import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { AnnouncerProvider } from "../../shared/Announcer";
import { LinksScreen } from "./LinksScreen";
import type { LinksView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>{children}</RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>
  );
}

const TWO_LINKS: LinksView = {
  version: 1,
  links: [
    { id: "l1", text: "First", url: "https://a.invalid" },
    { id: "l2", text: "Second", url: "https://b.invalid" },
  ],
};

describe("LinksScreen", () => {
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
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/links") return jsonResponse(200, TWO_LINKS);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LinksScreen />));
    await screen.findByRole("heading", { name: "Resource links", level: 1 });
    expect(document.title).toBe("Resource links — GCPE News Staff");
  });

  it("Move down then Save sends the whole reordered list in one PUT", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/links" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          return jsonResponse(200, { version: 2, links: body.links.map((l: Record<string, unknown>, i: number) => ({ id: l.id ?? `new-${i}`, text: l.text, url: l.url })) });
        }
        if (url === "/nrms/api/site/links") return jsonResponse(200, TWO_LINKS);
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<LinksScreen />));
    const user = userEvent.setup();
    await screen.findByDisplayValue("First");
    await user.click(screen.getByRole("button", { name: "Move link 1 down" }));
    await user.click(screen.getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/links" && c.init?.method === "PUT")).toBe(true));
    const call = calls.find((c) => c.url === "/nrms/api/site/links" && c.init?.method === "PUT")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({
      version: 1,
      links: [
        { id: "l2", text: "Second", url: "https://b.invalid" },
        { id: "l1", text: "First", url: "https://a.invalid" },
      ],
    });
  });

  // I3: dragging the whole row made it impossible to mouse-select text in its inputs. Only
  // the dedicated grip handle is draggable; the row and its fields are not.
  it("only the drag handle is draggable, not the row or its inputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/links") return jsonResponse(200, TWO_LINKS);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LinksScreen />));
    await screen.findByDisplayValue("First");
    const handle = screen.getByRole("img", { name: "Drag to reorder link 1" });
    expect(handle).toHaveAttribute("draggable", "true");

    const row = document.querySelectorAll(".gcpe-links__item")[0]!;
    expect(row).not.toHaveAttribute("draggable");
    const textField = screen.getByLabelText("Link 1 text");
    expect(textField.closest("[draggable='true']")).toBeNull();
  });

  // I4: moving a link to the first/last position disables that same direction's own button —
  // the one the user just pressed — the instant it re-renders at its new position, which drops
  // focus to <body> unless it's explicitly restored. Also announces the move.
  it("keyboard Move down on the last-but-one link restores focus (falling back to Move up) and announces the move", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/links") return jsonResponse(200, TWO_LINKS);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LinksScreen />));
    const user = userEvent.setup();
    const moveDown = await screen.findByRole("button", { name: "Move link 1 down" });
    moveDown.focus();
    await user.click(moveDown);

    expect(await screen.findByRole("status")).toHaveTextContent("Link 1 moved to position 2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Move link 2 up" })).toHaveFocus());
  });

  // Minors: Resource links stays NRMS.SiteEditor/Core.Admin only even though WebsiteScreen
  // itself now lets every read role through for Featured/Log.
  it("a Viewer can't reach Resource links at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LinksScreen />));
    await screen.findByText("You don’t have permission to view the resource links.");
    expect(screen.queryByDisplayValue("First")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save links" })).toBeNull();
  });
});
