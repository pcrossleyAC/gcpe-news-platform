import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { LinksScreen } from "./LinksScreen";
import type { LinksView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
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

  it("a Viewer sees no edit controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/links") return jsonResponse(200, TWO_LINKS);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<LinksScreen />));
    await screen.findByDisplayValue("First");
    expect(screen.queryByRole("button", { name: "Save links" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move link 1 down" })).toBeNull();
  });
});
