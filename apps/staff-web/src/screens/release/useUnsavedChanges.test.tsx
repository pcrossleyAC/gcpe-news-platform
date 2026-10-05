import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { useRegisterDirty, useUnsavedChangesGuard } from "./useUnsavedChanges";

/** A minimal stand-in for ReleaseEditorPage: one "section" that can be marked dirty, a link
 * away, and the blocker's own confirmation UI. */
function EditorHarness(): React.JSX.Element {
  const guard = useUnsavedChangesGuard();
  return (
    <guard.Provider>
      <h1>Editor</h1>
      <DirtySection />
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

function DirtySection(): React.JSX.Element {
  const [dirty, setDirty] = useState(false);
  useRegisterDirty("test-section", dirty);
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
});
