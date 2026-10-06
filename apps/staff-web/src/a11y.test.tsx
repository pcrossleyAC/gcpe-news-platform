import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { SessionProvider } from "./session/SessionContext";
import { SignIn } from "./screens/SignIn";
import { AppShell } from "./shell/AppShell";

function stubSession(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility (constraints.md: no serious/critical axe violations)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("the sign-in screen", async () => {
    stubSession(401, { error: "not signed in" });
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={["/sign-in"]}>
          <SignIn />
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByLabelText(/user name/i);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the app shell", async () => {
    stubSession(200, {
      user: { id: "1", name: "Pat", email: "pat@example.invalid", roles: ["Core.Admin"] },
      expiresAt: new Date().toISOString(),
    });
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell />
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByText("Signed in as Pat");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
