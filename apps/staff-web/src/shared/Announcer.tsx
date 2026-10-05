import { createContext, useCallback, useContext, useRef, useState } from "react";

export interface Announcer {
  announce(message: string): void;
}

const AnnouncerContext = createContext<Announcer | null>(null);

const NOOP: Announcer = { announce: () => {} };

/**
 * One shared polite live region for the whole app (I4), mounted once in AppShell. Every
 * section that saves, or reorders a list, calls `useAnnouncer().announce(...)` — "Saved" after
 * a successful section save (useReleaseSection/useVersionedSave), "<item> moved to position N"
 * after a keyboard (or drag) reorder — instead of each screen managing its own `aria-live`
 * region, which also avoids several competing regions fighting over a screen reader's attention.
 *
 * `useAnnouncer()` is safe to call with no provider in the tree — every section's own unit test
 * renders it in isolation, with no AppShell — it then falls back to a no-op rather than
 * throwing; only the real app (and e2e) renders the provider.
 */
export function AnnouncerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [message, setMessage] = useState("");
  // A screen reader only notices a *change* to a live region's text — announcing the exact same
  // string twice in a row (e.g. "Saved" after two separate, unrelated saves) needs the content
  // to actually differ each time, hence the toggled trailing zero-width space.
  const toggled = useRef(false);

  const announce = useCallback((next: string) => {
    toggled.current = !toggled.current;
    setMessage(toggled.current ? `${next}​` : next);
  }, []);

  return (
    <AnnouncerContext.Provider value={{ announce }}>
      {children}
      <div role="status" aria-live="polite" className="gcpe-visually-hidden">
        {message}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnouncer(): Announcer {
  return useContext(AnnouncerContext) ?? NOOP;
}
