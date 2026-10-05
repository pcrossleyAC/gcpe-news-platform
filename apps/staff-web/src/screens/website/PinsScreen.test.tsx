import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { PinsScreen } from "./PinsScreen";
import type { PinView } from "./types";

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const PRIMARY: PinView = { slot: "primary", pinned: false, version: 1, slide: { id: "p1", headline: "H", summary: "S", actionUrl: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null } };
const SECONDARY: PinView = { slot: "secondary", pinned: true, version: 3, slide: { id: "p2", headline: "H2", summary: "S2", actionUrl: "", facebookPostUrl: "", justify: "right", hasImage: false, imageUrl: null } };

describe("PinsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("pins and unpins, calling POST .../pins/:slot/pinned with the toggled value", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let pins = [PRIMARY, SECONDARY];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, pins);
        if (url === "/nrms/api/site/pins/primary/pinned" && init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          pins = pins.map((p) => (p.slot === "primary" ? { ...p, pinned: body.pinned, version: p.version + 1 } : p));
          return jsonResponse(200, pins.find((p) => p.slot === "primary"));
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<PinsScreen />));
    await screen.findByRole("heading", { name: "Emergency pins", level: 1 });
    const toggle = await screen.findByRole("switch", { name: "Primary is not pinned" });

    const user = userEvent.setup();
    await user.click(toggle);

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/pins/primary/pinned")).toBe(true));
    const call = calls.find((c) => c.url === "/nrms/api/site/pins/primary/pinned")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ version: 1, pinned: true });
    await screen.findByRole("switch", { name: "Primary is pinned" });
  });

  it("saves a pin's edited fields via PUT .../pins/:slot", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        if (url === "/nrms/api/site/pins/primary" && init?.method === "PUT") return jsonResponse(200, { ...PRIMARY, version: 2, slide: { ...PRIMARY.slide, headline: "New headline" } });
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<PinsScreen />));
    const user = userEvent.setup();
    const headlineField = await screen.findByLabelText("Primary headline");
    await user.clear(headlineField);
    await user.type(headlineField, "New headline");
    await user.click(screen.getByRole("button", { name: "Save primary pin" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/pins/primary" && c.init?.method === "PUT")).toBe(true));
    const call = calls.find((c) => c.url === "/nrms/api/site/pins/primary" && c.init?.method === "PUT")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ version: 1, headline: "New headline", summary: "S", actionUrl: "", facebookPostUrl: "", justify: "left" });
  });

  it("a Viewer sees no pin/unpin switch enabled and no save button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const toggle = await screen.findByRole("switch", { name: "Primary is not pinned" });
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save primary pin" })).toBeNull();
  });

  // Fix round 1, item 4: a wrong-type or too-large pin image upload must show something a
  // human can act on, not a blank/undefined error.
  it("a wrong-type pin image upload shows the server's 422 message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        if (url === "/nrms/api/site/pins/primary/image" && init?.method === "PUT") return jsonResponse(422, { errors: ["Upload a JPEG or PNG image."] });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const input = await screen.findByLabelText("Primary image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    await user.upload(input, new File(["not actually an image"], "notes.png", { type: "image/png" }));
    expect(await screen.findByText("Upload a JPEG or PNG image.")).toBeInTheDocument();
  });

  it("a too-large pin image upload (413) shows a clear message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        if (url === "/nrms/api/site/pins/primary/image" && init?.method === "PUT") return jsonResponse(413, { error: "request entity too large" });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const input = await screen.findByLabelText("Primary image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(10)], "big.png", { type: "image/png" }));
    expect(await screen.findByText("request entity too large")).toBeInTheDocument();
  });
});
