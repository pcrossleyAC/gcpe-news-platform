import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSeededForm } from "./useSeededForm";
import { SaveQueueContext, type SaveQueue } from "./saveQueue";

interface Form {
  key: string;
  summary: string;
  location: string;
}
const start: Form = { key: "clinics-open", summary: "Old summary", location: "" };

/** A page whose save queue says which version moves were this page's own saves. */
function wrapperWith(own: Array<[number, number]>) {
  const queue: SaveQueue = { run: (task) => task(null), isOwnChange: (from, to) => own.some(([a, b]) => a === from && b === to) };
  return ({ children }: { children: ReactNode }) => <SaveQueueContext.Provider value={queue}>{children}</SaveQueueContext.Provider>;
}

describe("useSeededForm: a change on the server meets the user's edits field by field", () => {
  it("a server change to a field the user didn't touch is taken in; the user's edit stays; the save uses the new version", () => {
    const { result, rerender } = renderHook(({ seed, version }) => useSeededForm<Form>(seed, version), { initialProps: { seed: start, version: 1 } });
    act(() => result.current.setForm((f) => ({ ...f, location: "VICTORIA" })));
    // Saving the document regenerated the summary (and, for a story, the key) on the server.
    rerender({ seed: { ...start, summary: "New summary", key: "clinics-open-weekends" }, version: 2 });
    expect(result.current.form).toEqual({ key: "clinics-open-weekends", summary: "New summary", location: "VICTORIA" });
    expect(result.current.dirty).toBe(true);
    expect(result.current.staleVersion).toBeNull();
  });

  it("someone else's change to a field the user edited is a conflict: the save is pinned to the version the user started from", () => {
    const { result, rerender } = renderHook(({ seed, version }) => useSeededForm<Form>(seed, version), { initialProps: { seed: start, version: 1 } });
    act(() => result.current.setForm((f) => ({ ...f, location: "VICTORIA" })));
    rerender({ seed: { ...start, location: "KAMLOOPS" }, version: 3 });
    expect(result.current.form.location).toBe("VICTORIA");
    expect(result.current.staleVersion).toBe(1);
  });

  it("when this page's own save changed a field the user edited (a story's key regenerated from the new headline), the user's value wins", () => {
    const { result, rerender } = renderHook(({ seed, version }) => useSeededForm<Form>(seed, version), {
      initialProps: { seed: start, version: 1 },
      wrapper: wrapperWith([[1, 2]]),
    });
    act(() => result.current.setForm((f) => ({ ...f, key: "my-own-key" })));
    rerender({ seed: { ...start, key: "generated-from-headline", summary: "New summary" }, version: 2 });
    expect(result.current.form).toEqual({ key: "my-own-key", summary: "New summary", location: "" });
    expect(result.current.dirty).toBe(true);
    expect(result.current.staleVersion).toBeNull();
  });

  it("the same server change by someone else (not this page's save) still conflicts", () => {
    const { result, rerender } = renderHook(({ seed, version }) => useSeededForm<Form>(seed, version), {
      initialProps: { seed: start, version: 1 },
      wrapper: wrapperWith([[2, 3]]),
    });
    act(() => result.current.setForm((f) => ({ ...f, key: "my-own-key" })));
    rerender({ seed: { ...start, key: "someone-elses-key" }, version: 2 });
    expect(result.current.staleVersion).toBe(1);
  });
});
