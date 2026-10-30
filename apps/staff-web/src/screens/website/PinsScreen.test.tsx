import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
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

const PRIMARY: PinView = { slot: "primary", pinned: false, version: 1, slide: { id: "p1", headline: "H", summary: "S", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left", hasImage: false, imageUrl: null } };
const SECONDARY: PinView = { slot: "secondary", pinned: true, version: 3, slide: { id: "p2", headline: "H2", summary: "S2", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "right", hasImage: false, imageUrl: null } };

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
    // I5: document.title matches the h1.
    await waitFor(() => expect(document.title).toBe("Emergency pins — GCPE News Staff"));
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
    // Ctrl+S (⌘S on a Mac) saves the pin the focus is in — this one, not the other.
    fireEvent.keyDown(headlineField, { key: "s", ctrlKey: true });

    await waitFor(() => expect(calls.some((c) => c.url === "/nrms/api/site/pins/primary" && c.init?.method === "PUT")).toBe(true));
    expect(calls.some((c) => c.url === "/nrms/api/site/pins/secondary" && c.init?.method === "PUT")).toBe(false);
    const call = calls.find((c) => c.url === "/nrms/api/site/pins/primary" && c.init?.method === "PUT")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ version: 1, headline: "New headline", summary: "S", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left" });
  });

  it("edits a pin's Action label (with its hint) and sends actionLabel", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        if (url === "/nrms/api/site/pins/primary" && init?.method === "PUT") return jsonResponse(422, { errors: ["Keep the action label to 40 characters or fewer, in plain text."] });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Primary action label"), "Get help");
    expect(screen.getAllByText("The link text. Leave empty for the default set in Navigation and labels.")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Save primary pin" }));
    expect(await screen.findByText("Keep the action label to 40 characters or fewer, in plain text.")).toBeInTheDocument();
    const call = calls.find((c) => c.init?.method === "PUT")!;
    expect(JSON.parse(call.init!.body as string)).toMatchObject({ actionLabel: "Get help" });
  });

  // I1: a 409 on save must not leave the form showing the editor's stale local text once the
  // user reloads — reload must re-seed the form from the server's current values.
  it("409 on save -> Reload shows the server's current values, not the local edit", async () => {
    let primary = PRIMARY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [primary, SECONDARY]);
        if (url === "/nrms/api/site/pins/primary" && init?.method === "PUT") return jsonResponse(409, { error: "conflict", code: "version_conflict" });
        throw new Error(`unhandled: ${url}`);
      }),
    );

    render(withAuth(<PinsScreen />));
    const headlineField = await screen.findByLabelText("Primary headline");
    expect(headlineField).toHaveValue("H");

    const user = userEvent.setup();
    await user.clear(headlineField);
    await user.type(headlineField, "My local edit");
    await user.click(screen.getByRole("button", { name: "Save primary pin" }));

    await screen.findByText("Someone else changed this — reload to see their changes.");

    primary = { ...primary, version: 2, slide: { ...primary.slide, headline: "Server headline" } };

    await user.click(screen.getByRole("button", { name: "Reload" }));

    const reloaded = await screen.findByLabelText("Primary headline");
    expect(reloaded).toHaveValue("Server headline");
    expect(screen.queryByText("Someone else changed this — reload to see their changes.")).toBeNull();
  });

  // Minors: Emergency pins stays NRMS.SiteEditor/Core.Admin only even though WebsiteScreen
  // itself now lets every read role through for Featured/Log — a Viewer gets the
  // permission-denied message, not the read-only screen.
  it("a Viewer can't reach Emergency pins at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    await screen.findByText("You don’t have permission to view the emergency pins.");
    expect(screen.queryByRole("switch")).toBeNull();
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
    expect(await screen.findByText("That image is over 2 MB. Choose a smaller image.")).toBeInTheDocument();
    expect(screen.queryByText("request entity too large")).toBeNull();
  });

  it("an image over 2 MB is refused in the Hub, before anything is sent", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const input = await screen.findByLabelText("Primary image (JPEG or PNG, up to 2 MB)");
    const user = userEvent.setup();
    await user.upload(input, new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect(await screen.findByText("That image is over 2 MB. Choose a smaller image.")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  it.each([
    ["Primary action URL", "Primary: Enter a full web address for Action URL, starting with http:// or https://"],
    ["Primary Facebook post URL", "Primary: Enter a full web address for Facebook post URL, starting with http:// or https://"],
  ])("a bad web address in %s is named before saving, and nothing is sent", async (label, message) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(label), "www.example.com");
    await user.click(screen.getByRole("button", { name: "Save primary pin" }));
    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    const field = screen.getByLabelText(label);
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message.replace("Primary: ", "")));
    const found = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(found.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);
  });

  it("flipping the pin switch with unsaved edits refuses, keeps the typing and sends nothing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.SiteEditor"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/site/pins") return jsonResponse(200, [PRIMARY, SECONDARY]);
        throw new Error(`unhandled: ${url}`);
      }),
    );
    render(withAuth(<PinsScreen />));
    const user = userEvent.setup();
    const headline = await screen.findByLabelText("Primary headline");
    await user.clear(headline);
    await user.type(headline, "Evacuation order");
    await user.click(screen.getByRole("switch", { name: "Primary is not pinned" }));
    expect(await screen.findByText("Save your changes first.")).toBeInTheDocument();
    expect(screen.getByLabelText("Primary headline")).toHaveValue("Evacuation order");
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });
});
