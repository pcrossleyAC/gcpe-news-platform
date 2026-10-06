import { describe, expect, it } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { ApiError } from "../../api/client";
import { AnnouncerProvider } from "../../shared/Announcer";
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

  // Minors: same code-aware distinction as release/useReleaseSection.ts — a 409 with
  // `code: "state"` isn't a version conflict and falls through to the generic error branch.
  it("a 409 with code 'state' is not treated as a version conflict", async () => {
    const { result } = renderHook(() => useVersionedSave());
    await act(async () => {
      await result.current.run(async () => {
        throw new ApiError({ status: 409, message: "This action isn't allowed right now.", code: "state" });
      });
    });
    expect(result.current.conflict).toBe(false);
    expect(result.current.error).toBe("This action isn't allowed right now.");
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

  // I4: one shared "Saved" announcement for every Website section save too.
  it("a successful run() announces \"Saved\" through the shared AnnouncerProvider", async () => {
    function Harness() {
      const section = useVersionedSave<{ ok: true }>();
      return (
        <button type="button" onClick={() => void section.run(async () => ({ ok: true }))}>
          Save
        </button>
      );
    }
    render(
      <AnnouncerProvider>
        <Harness />
      </AnnouncerProvider>,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
      await Promise.resolve();
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
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
