import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { DirtyKeysProvider, useUnsavedChangesGuard } from "./useUnsavedChanges";
import { UnsavedChangesBar } from "./UnsavedChangesBar";

/** Tests only: a release-editor section with the page's unsaved-changes guard and its one Save
 * (the sticky bar's "Save changes") around it, as ReleaseEditorPage gives it. */
function WithSaveBar({ children }: { children: ReactNode }): React.JSX.Element {
  const guard = useUnsavedChangesGuard();
  return (
    <guard.Provider>
      <DirtyKeysProvider keys={guard.dirtyKeys}>
        {children}
        <UnsavedChangesBar sections={guard.dirtySections} state={guard.saveState} onSave={() => void guard.saveAll()} />
      </DirtyKeysProvider>
    </guard.Provider>
  );
}

/** Renders `ui` inside {@link WithSaveBar}, under a data router (the guard's useBlocker needs
 * one); `outer` wraps the router itself (e.g. a SessionProvider). */
export function renderWithSaveBar(ui: ReactElement, outer: (router: ReactElement) => ReactElement = (r) => r): RenderResult {
  const router = createMemoryRouter([{ path: "/", element: <WithSaveBar>{ui}</WithSaveBar> }], { initialEntries: ["/"] });
  return render(outer(<RouterProvider router={router} />));
}
