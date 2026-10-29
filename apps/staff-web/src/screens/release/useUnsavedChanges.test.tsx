import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AnnouncerProvider } from "../../shared/Announcer";
import { useRegisterDirty, useUnsavedChangesGuard, type DirtySection as DirtySectionEntry } from "./useUnsavedChanges";

/** A minimal stand-in for ReleaseEditorPage: one "section" that can be marked dirty, a link
 * away, and the blocker's own confirmation UI — plus whatever `dirtySections` the guard
 * currently reports, so the registry itself (not just navigation-blocking) is exercised. */
function EditorHarness({ onDirtySections }: { onDirtySections?: (s: DirtySectionEntry[]) => void } = {}): React.JSX.Element {
  const guard = useUnsavedChangesGuard();
  onDirtySections?.(guard.dirtySections);
  return (
    <guard.Provider>
      <h1>Editor</h1>
      <DirtySection />
      <ul aria-label="dirty sections">
        {guard.dirtySections.map((s) => (
          <li key={s.key}>{s.label}</li>
        ))}
      </ul>
      {guard.blocker.state === "blocked" && (
        <div role="alertdialog" aria-label="Unsaved changes">
          <p>You have unsaved changes.</p>
          <button onClick={() => guard.blocker.proceed?.()}>Leave</button>
          <button onClick={() => guard.blocker.reset?.()}>Stay</button>
        </div>
      )}
    </guard.Provider>
  );
}

function DirtySection({ save }: { save?: () => Promise<boolean> } = {}): React.JSX.Element {
  const [dirty, setDirty] = useState(false);
  useRegisterDirty("test-section", dirty, { label: "Test section", save: save ?? (async () => true) });
  return <button onClick={() => setDirty(true)}>Make dirty</button>;
}

function Elsewhere(): React.JSX.Element {
  return <p>Elsewhere</p>;
}

function renderHarness() {
  const router = createMemoryRouter(
    [
      { path: "/editor", element: <EditorHarness /> },
      { path: "/elsewhere", element: <Elsewhere /> },
    ],
    { initialEntries: ["/editor"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("useUnsavedChangesGuard", () => {
  afterEach(() => cleanup());

  it("does not block navigation while nothing is dirty", async () => {
    const router = renderHarness();
    const user = userEvent.setup();
    router.navigate("/elsewhere");
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
    void user;
  });

  it("blocks in-app navigation while a section is dirty, and Stay keeps the user on the page", async () => {
    const router = renderHarness();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make dirty" }));

    router.navigate("/elsewhere");
    expect(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/editor");

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/editor");
  });

  it("Leave proceeds with the navigation", async () => {
    const router = renderHarness();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make dirty" }));

    router.navigate("/elsewhere");
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
  });

  it("sets beforeunload's returnValue while dirty, for the tab-close case", async () => {
    renderHarness();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make dirty" }));

    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  // Sticky save bar (ReleaseEditorPage): the registry exposes a label/save per dirty section.
  it("dirtySections carries the registered label, empty while clean", async () => {
    renderHarness();
    expect(screen.getByRole("list", { name: "dirty sections" })).toBeEmptyDOMElement();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Make dirty" }));
    expect(screen.getByRole("listitem")).toHaveTextContent("Test section");
  });

  it("dirtySections' save calls through to whatever the latest render's save callback is (never a stale one)", async () => {
    const calls: string[] = [];
    function Harness(): React.JSX.Element {
      const guard = useUnsavedChangesGuard();
      const [value, setValue] = useState("first");
      return (
        <guard.Provider>
          <input aria-label="value" value={value} onChange={(e) => setValue(e.target.value)} />
          <SavingSection value={value} onSave={(v) => calls.push(v)} />
          {guard.dirtySections.map((s) => (
            <button key={s.key} onClick={() => void s.save()}>
              Save {s.label}
            </button>
          ))}
        </guard.Provider>
      );
    }
    function SavingSection({ value, onSave }: { value: string; onSave: (v: string) => void }): React.JSX.Element {
      useRegisterDirty("saving-section", value !== "first", {
        label: "Saving section",
        save: async () => {
          onSave(value);
          return true;
        },
      });
      return <></>;
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("value"));
    await user.type(screen.getByLabelText("value"), "second");
    await user.click(screen.getByRole("button", { name: "Save Saving section" }));
    expect(calls).toEqual(["second"]);
  });

  it("announces once when the bar first appears, not again on a later keystroke", async () => {
    function Harness(): React.JSX.Element {
      const guard = useUnsavedChangesGuard();
      const [text, setText] = useState("");
      return (
        <guard.Provider>
          <input aria-label="text" value={text} onChange={(e) => setText(e.target.value)} />
          <SavingSection dirty={text !== ""} />
        </guard.Provider>
      );
    }
    function SavingSection({ dirty }: { dirty: boolean }): React.JSX.Element {
      useRegisterDirty("s", dirty, { label: "Section", save: async () => true });
      return <></>;
    }
    render(
      <AnnouncerProvider>
        <RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />
      </AnnouncerProvider>,
    );
    const user = userEvent.setup();
    const status = screen.getByRole("status");
    await user.type(screen.getByLabelText("text"), "a");
    await waitFor(() => expect(status).toHaveTextContent(/unsaved changes/i));
    const afterFirst = status.textContent;
    await user.type(screen.getByLabelText("text"), "bc");
    await new Promise((r) => setTimeout(r, 0));
    expect(status.textContent).toBe(afterFirst);
  });

  describe("saveAll (the page's one Save)", () => {
    /** Sections that each become dirty from a checkbox and save through `saves`, which the test
     * resolves by hand (true: saved, false: failed — the section shows its own message). */
    function SaveAllHarness({ keys, saves }: { keys: string[]; saves: { key: string; resolve(ok: boolean): void }[] }): React.JSX.Element {
      const guard = useUnsavedChangesGuard();
      return (
        <guard.Provider>
          {keys.map((k) => (
            <PendingSection key={k} id={k} saves={saves} />
          ))}
          <button onClick={() => void guard.saveAll()}>Save changes</button>
          <p data-testid="state">{guard.saveState.status}</p>
          <p data-testid="failed">{guard.saveState.failed?.label ?? ""}</p>
          <p data-testid="not-saved">{guard.saveState.notSaved?.map((s) => s.label).join(", ") ?? ""}</p>
        </guard.Provider>
      );
    }
    function PendingSection({ id, saves }: { id: string; saves: { key: string; resolve(ok: boolean): void }[] }): React.JSX.Element {
      const [dirty, setDirty] = useState(false);
      useRegisterDirty(id, dirty, {
        label: `${id} label`,
        save: () =>
          new Promise<boolean>((resolve) =>
            saves.push({
              key: id,
              resolve: (ok) => {
                if (ok) setDirty(false);
                resolve(ok);
              },
            }),
          ),
      });
      return (
        <label>
          <input type="checkbox" checked={dirty} onChange={() => setDirty(!dirty)} />
          Edit {id}
        </label>
      );
    }
    function renderSaveAll(keys: string[]) {
      const saves: { key: string; resolve(ok: boolean): void }[] = [];
      render(
        <AnnouncerProvider>
          <RouterProvider router={createMemoryRouter([{ path: "/", element: <SaveAllHarness keys={keys} saves={saves} /> }])} />
        </AnnouncerProvider>,
      );
      return { saves, user: userEvent.setup() };
    }

    it("saves every dirty section one after another, in page order (documents, page details, categories, asset, settings), not the order they were edited", async () => {
      const { saves, user } = renderSaveAll(["settings", "categories", "document-d1-4105", "page-details"]);
      for (const k of ["settings", "categories", "document-d1-4105", "page-details"]) await user.click(screen.getByLabelText(`Edit ${k}`));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(screen.getByTestId("state")).toHaveTextContent("saving");
      const order: string[] = [];
      for (let i = 0; i < 4; i++) {
        await waitFor(() => expect(saves).toHaveLength(i + 1));
        expect(saves).toHaveLength(i + 1); // the next waits until this one has finished
        order.push(saves[i]!.key);
        await act(async () => saves[i]!.resolve(true));
      }
      expect(order).toEqual(["document-d1-4105", "page-details", "categories", "settings"]);
      await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("saved"));
    });

    it("announces one polite \"Saved\" when every section has saved, not one per section", async () => {
      const { saves, user } = renderSaveAll(["page-details", "categories"]);
      await user.click(screen.getByLabelText("Edit page-details"));
      await user.click(screen.getByLabelText("Edit categories"));
      const status = screen.getByRole("status");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(saves).toHaveLength(1));
      await act(async () => saves[0]!.resolve(true));
      await waitFor(() => expect(saves).toHaveLength(2));
      expect(status).not.toHaveTextContent(/^Saved/);
      await act(async () => saves[1]!.resolve(true));
      await waitFor(() => expect(status).toHaveTextContent(/^Saved/));
    });

    it("stops at the first section that fails: it is reported, and the sections after it are not sent and stay unsaved", async () => {
      const { saves, user } = renderSaveAll(["page-details", "categories", "settings"]);
      for (const k of ["page-details", "categories", "settings"]) await user.click(screen.getByLabelText(`Edit ${k}`));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(saves).toHaveLength(1));
      await act(async () => saves[0]!.resolve(true));
      await waitFor(() => expect(saves).toHaveLength(2));
      await act(async () => saves[1]!.resolve(false));
      await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("failed"));
      expect(screen.getByTestId("failed")).toHaveTextContent("categories label");
      expect(screen.getByTestId("not-saved")).toHaveTextContent("settings label");
      expect(saves).toHaveLength(2); // settings was never sent
      expect(screen.getByLabelText("Edit settings")).toBeChecked(); // and keeps its edit
      expect(screen.getByLabelText("Edit categories")).toBeChecked();
    });

    it("a second Save while one is running does nothing (no section is sent twice)", async () => {
      const { saves, user } = renderSaveAll(["page-details"]);
      await user.click(screen.getByLabelText("Edit page-details"));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(saves).toHaveLength(1));
      await act(async () => saves[0]!.resolve(true));
      await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("saved"));
      expect(saves).toHaveLength(1);
    });
  });
});
