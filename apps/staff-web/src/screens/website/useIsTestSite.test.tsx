import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { jsonResponse } from "../../../test/jsonResponse";
import { useIsTestSite } from "./useIsTestSite";

describe("useIsTestSite", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns config.isTestSite once GET /nrms/api/config resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/nrms/api/config" ? jsonResponse(200, { isTestSite: true }) : jsonResponse(200, {}))),
    );
    const { result } = renderHook(() => useIsTestSite());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("fails safe to false if the config fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    const { result } = renderHook(() => useIsTestSite());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });
});
