import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { AppShell } from "./AppShell";

vi.mock("../manuals/visible-pages", async (importOriginal) => ({ ...(await importOriginal<typeof import("../manuals/visible-pages")>()), MANUALS_DATA: (await import("../manuals/test-fixtures")).FIXTURE }));

function renderShell(roles: string[], path: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ user: { id: "1", name: "Pat", email: "p@x.invalid", roles }, expiresAt: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } })),
  );
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("the header's Help opens the reader's manual page for the screen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("opens the release editor's page on a release", async () => {
    renderShell(["NRMS.Editor"], "/releases/abc");
    await screen.findByText("Signed in as Pat");
    expect(screen.getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help/manuals/nrms-editor/editor-releases");
  });
  it("keeps the How do I… anchor where no manual page covers the screen", async () => {
    renderShell(["NRMS.Editor"], "/calendar");
    await screen.findByText("Signed in as Pat");
    expect(screen.getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help#how-calendar");
  });
});
