import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * WCAG 2.4.2 (I5): moves focus to the current screen's `h1` whenever the route changes, so a
 * screen-reader/keyboard user lands somewhere meaningful instead of wherever focus happened to
 * be on the previous screen (often nowhere, or a now-gone element). Attach the returned ref to
 * the `<main>` element that wraps every routed screen (`<Outlet/>`).
 *
 * The screen's `h1` isn't always there yet on the first render after navigating — several
 * screens render a plain "Loading…" (no `h1`) until their first fetch resolves — so this
 * doesn't just check once: a `MutationObserver` keeps watching until an `h1` actually shows up,
 * then disconnects. `location.pathname` (not the whole `location` object, which also changes
 * on every search-param update) is what re-triggers it, which also covers navigating between
 * two different ids on the same route (e.g. `/releases/A` → `/releases/B` doesn't remount
 * {@link ReleaseEditorPage}, but its pathname still changes).
 */
export function useFocusH1OnRouteChange<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const main = ref.current;
    if (!main) return;

    const focusH1 = (): boolean => {
      const h1 = main.querySelector("h1");
      if (!h1) return false;
      if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      h1.focus();
      return true;
    };

    if (focusH1()) return;

    const observer = new MutationObserver(() => {
      if (focusH1()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  return ref;
}
