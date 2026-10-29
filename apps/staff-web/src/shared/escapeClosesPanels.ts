import { useEffect } from "react";

/** A toggle button that has its panel open. */
const OPEN_TOGGLE = 'button[aria-expanded="true"][aria-controls], [role="button"][aria-expanded="true"][aria-controls]';

function cssEscape(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
}

/** The open panel's toggle, when focus is on it or inside its panel (the innermost panel). */
function toggleFor(active: Element): HTMLElement | null {
  if (active.matches(OPEN_TOGGLE)) return active as HTMLElement;
  for (let el: Element | null = active; el; el = el.parentElement) {
    if (!el.id) continue;
    const toggle = document.querySelector<HTMLElement>(`[aria-controls~="${cssEscape(el.id)}"][aria-expanded="true"]`);
    if (toggle && toggle.matches(OPEN_TOGGLE)) return toggle;
  }
  return null;
}

/**
 * Esc closes the expandable panel or disclosure the user is in, everywhere in the Hub, and puts
 * focus back on what opened it (owner decision 2026-10-29: Esc closes dialogs and panels
 * consistently). Dialogs keep their own Esc (React Aria closes them and restores focus); this
 * covers the rest:
 *  - a panel opened by a toggle button (`aria-expanded` + `aria-controls`: Schedule, the calendar
 *    list's tools, a user's or organization's editor, a release editor card's disclosure) — Esc
 *    presses that toggle, so the screen's own close logic runs;
 *  - an open `<details>` (Calendar Filters, Saved views) — closed, focus to its summary.
 * Anything that already handled Esc (the section menu, a dialog, a date picker) is left alone, as
 * is a search box with text in it (Esc clears it).
 */
export function useEscapeClosesPanels(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      if (!active || active === document.body) return;
      if (active.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (active instanceof HTMLInputElement && active.type === "search" && active.value !== "") return;
      const toggle = toggleFor(active);
      const details = active.closest("details[open]");
      // The innermost wins: a toggle inside an open <details>, or a <details> inside a panel.
      if (toggle && (!details || details.contains(toggle))) {
        e.preventDefault();
        toggle.click();
        toggle.focus();
        return;
      }
      if (details instanceof HTMLDetailsElement) {
        e.preventDefault();
        details.open = false;
        details.querySelector<HTMLElement>(":scope > summary")?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
