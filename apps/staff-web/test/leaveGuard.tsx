import { expect } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from "react-router";
import { SessionProvider } from "../src/session/SessionContext";
import { RequireAuth } from "../src/session/RequireAuth";
import { AnnouncerProvider } from "../src/shared/Announcer";

/**
 * Suite review H2/W9: renders one edit screen the way the Hub does for the leave-page guard — a
 * data router (blocking needs one), RequireAuth (the shell's unsaved-changes state) — with a
 * second address, /elsewhere, to leave for.
 */
export function renderGuarded(element: ReactElement, opts: { path?: string; at?: string; parent?: Omit<RouteObject, "children" | "path" | "index"> & { path: string }; extra?: RouteObject[] } = {}) {
  const path = opts.path ?? "/screen";
  const screenRoute: RouteObject = opts.parent ? { ...opts.parent, children: [{ path, element }] } as RouteObject : { path, element };
  const router = createMemoryRouter(
    [
      {
        element: (
          <AnnouncerProvider>
            <RequireAuth>
              <OutletHost />
            </RequireAuth>
          </AnnouncerProvider>
        ),
        children: [screenRoute, { path: "/elsewhere", element: <h1>Somewhere else</h1> }, ...(opts.extra ?? [])],
      },
    ],
    { initialEntries: [opts.at ?? path] },
  );
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

function OutletHost(): React.JSX.Element {
  return <Outlet />;
}

type Router = ReturnType<typeof renderGuarded>;

/** Leaving asks first: Stay keeps the screen (and its changes), Leave goes. */
export async function expectLeaveAsks(router: Router, user: UserEvent): Promise<void> {
  const from = router.state.location.pathname;
  void router.navigate("/elsewhere");
  const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
  expect(dialog).toHaveTextContent("You have unsaved changes on this page. Leave anyway and discard them?");
  await user.click(within(dialog).getByRole("button", { name: "Stay" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(router.state.location.pathname).toBe(from);
  void router.navigate("/elsewhere");
  await user.click(within(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).getByRole("button", { name: "Leave" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Somewhere else" })).toBeInTheDocument();
}

/** Nothing unsaved: leaving just goes. */
export async function expectLeaveFree(router: Router): Promise<void> {
  void router.navigate("/elsewhere");
  expect(await screen.findByRole("heading", { level: 1, name: "Somewhere else" })).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).toBeNull();
}
