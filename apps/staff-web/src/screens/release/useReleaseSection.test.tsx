import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { useReleaseSection } from "./useReleaseSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("useReleaseSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("save() PUTs to /nrms/api/releases/<id><path> and replaces the view with the response", async () => {
    const saved = releaseView({ version: 2, keywords: "updated" });
    const fetchMock = vi.fn(async () => jsonResponse(200, saved));
    vi.stubGlobal("fetch", fetchMock);

    const initial = releaseView({ version: 1 });
    let current = initial;
    const setView = (v: typeof initial) => {
      current = v;
    };
    const { result } = renderHook(() => useReleaseSection(current, setView));

    await act(async () => {
      await result.current.save("/meta", { version: 1, keywords: "updated" });
    });

    expect(fetchMock).toHaveBeenCalledWith(`/nrms/api/releases/${initial.id}/meta`, expect.objectContaining({ method: "PUT" }));
    expect(current).toEqual(saved);
  });

  it("defaults to PUT but can POST (e.g. the features endpoint)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, releaseView()));
    vi.stubGlobal("fetch", fetchMock);
    const v = releaseView();
    const { result } = renderHook(() => useReleaseSection(v, () => {}));

    await act(async () => {
      await result.current.save("/features", { kind: "home", key: "default", slot: "top", on: true }, "POST");
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));
  });

  it("a 409 sets `conflict` and leaves `view` untouched — never retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "version conflict" })),
    );
    const v = releaseView();
    const setView = vi.fn();
    const { result } = renderHook(() => useReleaseSection(v, setView));

    await act(async () => {
      await result.current.save("/meta", { version: 1 });
    });

    expect(result.current.conflict).toBe(true);
    expect(result.current.problems).toBeNull();
    expect(setView).not.toHaveBeenCalled();
  });

  it("a 422 sets `problems` from the server's problems array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(422, { error: "bad", problems: ["Choose at least one ministry."] })),
    );
    const v = releaseView();
    const { result } = renderHook(() => useReleaseSection(v, () => {}));

    await act(async () => {
      await result.current.save("/categories", { version: 1 });
    });

    expect(result.current.problems).toEqual(["Choose at least one ministry."]);
    expect(result.current.conflict).toBe(false);
  });

  it("reload() re-fetches the release and replaces the view", async () => {
    const fresh = releaseView({ version: 5 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(`/nrms/api/releases/${fresh.id}`);
        return jsonResponse(200, fresh);
      }),
    );
    const setView = vi.fn();
    const v = releaseView({ version: 1 });
    const { result } = renderHook(() => useReleaseSection(v, setView));

    let returned;
    await act(async () => {
      returned = await result.current.reload();
    });

    expect(setView).toHaveBeenCalledWith(fresh);
    expect(returned).toEqual(fresh);
    expect(result.current.conflict).toBe(false);
  });

  it("clear() resets problems/conflict/error without touching the view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "conflict" })),
    );
    const v = releaseView();
    const { result } = renderHook(() => useReleaseSection(v, () => {}));
    await act(async () => {
      await result.current.save("/meta", { version: 1 });
    });
    expect(result.current.conflict).toBe(true);

    act(() => result.current.clear());
    expect(result.current.conflict).toBe(false);
  });
});
