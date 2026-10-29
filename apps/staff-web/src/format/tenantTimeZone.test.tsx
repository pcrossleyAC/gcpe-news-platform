import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SessionProvider, useSession } from "../session/SessionContext";
import { useTenantTimeZone, useTenantTimeZoneStatus } from "./tenantTimeZone";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function SessionGate({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const session = useSession();
  return session.loading ? null : <>{children}</>;
}

function Probe(): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  return <p>time zone: {timeZone}</p>;
}

describe("useTenantTimeZone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("fetches GET /nrms/api/config and returns its timeZone", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("time zone: America/Vancouver")).toBeInTheDocument());
    expect(calls).toEqual(["/nrms/api/config"]);
  });

  it("asks NRMS only for staff it would answer: others read the tenant zone from Core, and NRMS staff still use NRMS", async () => {
    const signedIn = async (roles: string[]) => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          calls.push(url);
          if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
          if (url === "/core/api/time-zone-check") return jsonResponse(200, { timeZone: "America/Edmonton", tzCheck: { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 } });
          if (url === "/nrms/api/config") return roles.includes("NRMS.Viewer") ? jsonResponse(200, { timeZone: "America/Regina" }) : jsonResponse(403, { error: "forbidden" });
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      // Mounted only once the session has loaded, as RequireAuth does for every screen.
      render(
        <SessionProvider>
          <SessionGate>
            <Probe />
          </SessionGate>
        </SessionProvider>,
      );
      return calls;
    };
    let calls = await signedIn(["NoD.Editor", "Calendar.User"]);
    await screen.findByText("time zone: America/Edmonton");
    expect(calls).not.toContain("/nrms/api/config");
    cleanup();
    calls = await signedIn(["NRMS.Viewer"]);
    await screen.findByText("time zone: America/Regina");
    expect(calls).not.toContain("/core/api/time-zone-check");
  });

  it("falls back to a valid IANA zone while loading and if the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    render(<Probe />);
    // Never resolves to an empty/invalid value — always some real IANA zone (Intl would throw
    // immediately for an invalid one, so the component rendering at all here proves this).
    await waitFor(() => expect(screen.getByText(/^time zone: .+/)).toBeInTheDocument());
  });

  it("useTenantTimeZoneStatus is unresolved until the config answers, and resolved (on the fallback) when it fails", async () => {
    function StatusProbe(): React.JSX.Element {
      const { timeZone, resolved } = useTenantTimeZoneStatus();
      return <p>{resolved ? `resolved: ${timeZone}` : "unresolved"}</p>;
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { timeZone: "America/Moncton" })));
    render(<StatusProbe />);
    expect(screen.getByText("unresolved")).toBeInTheDocument();
    await screen.findByText("resolved: America/Moncton");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    render(<StatusProbe />);
    await screen.findByText("resolved: America/Vancouver");
  });
});
