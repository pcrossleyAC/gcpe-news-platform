/** axe checks for Users and the error log (task-5-brief.md's "axe clean on every screen"). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { UsersScreen } from "./users/UsersScreen";
import { ErrorLogScreen } from "./errors/ErrorLogScreen";
import type { UserView } from "./users/UsersScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

const ONE_USER: UserView = { id: "u1", email: "pat@x.invalid", displayName: "Pat", isActive: true, signInMethod: "local", roles: ["Core.Admin"] };

describe("accessibility — Users and error log", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("UsersScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/users") return jsonResponse(200, [ONE_USER]);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<UsersScreen />));
    await screen.findByText("pat@x.invalid");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("ErrorLogScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/stack/errors?limit=200") return jsonResponse(200, { errors: [{ timestamp: "2026-10-05T10:00:00.000Z", message: "boom", pid: 1, startedAt: "2026-10-05T00:00:00.000Z" }] });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<ErrorLogScreen />));
    await screen.findByText("boom");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
