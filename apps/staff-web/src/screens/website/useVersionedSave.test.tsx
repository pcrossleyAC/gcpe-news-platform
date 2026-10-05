import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "../../api/client";
import { useVersionedSave } from "./useVersionedSave";

describe("useVersionedSave", () => {
  it("returns the action's result and clears state on success", async () => {
    const { result } = renderHook(() => useVersionedSave<{ ok: true }>());
    let returned: { ok: true } | null = null;
    await act(async () => {
      returned = await result.current.run(async () => ({ ok: true }));
    });
    expect(returned).toEqual({ ok: true });
    expect(result.current.saving).toBe(false);
    expect(result.current.problems).toBeNull();
    expect(result.current.conflict).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("a 409 sets conflict and returns null, without touching problems/error", async () => {
    const { result } = renderHook(() => useVersionedSave());
    let returned: unknown = "unset";
    await act(async () => {
      returned = await result.current.run(async () => {
        throw new ApiError({ status: 409, message: "Someone else changed this — reload to see their changes." });
      });
    });
    expect(returned).toBeNull();
    expect(result.current.conflict).toBe(true);
    expect(result.current.problems).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("a 422 sets problems from the ApiError's problems array", async () => {
    const { result } = renderHook(() => useVersionedSave());
    await act(async () => {
      await result.current.run(async () => {
        throw new ApiError({ status: 422, message: "bad", problems: ["Choose a go-live time in the future."] });
      });
    });
    expect(result.current.problems).toEqual(["Choose a go-live time in the future."]);
    expect(result.current.conflict).toBe(false);
  });

  it("any other failure sets a generic error message", async () => {
    const { result } = renderHook(() => useVersionedSave());
    await act(async () => {
      await result.current.run(async () => {
        throw new ApiError({ status: 500, message: "boom" });
      });
    });
    expect(result.current.error).toBe("boom");
  });

  it("clear() resets to the initial state", async () => {
    const { result } = renderHook(() => useVersionedSave());
    await act(async () => {
      await result.current.run(async () => {
        throw new ApiError({ status: 409, message: "conflict" });
      });
    });
    expect(result.current.conflict).toBe(true);
    act(() => result.current.clear());
    expect(result.current.conflict).toBe(false);
  });
});
