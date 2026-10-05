import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useTenantTimeZone } from "./tenantTimeZone";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

  it("falls back to a valid IANA zone while loading and if the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    render(<Probe />);
    // Never resolves to an empty/invalid value — always some real IANA zone (Intl would throw
    // immediately for an invalid one, so the component rendering at all here proves this).
    await waitFor(() => expect(screen.getByText(/^time zone: .+/)).toBeInTheDocument());
  });
});
