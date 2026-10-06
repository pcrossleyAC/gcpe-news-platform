import { useCallback, useRef } from "react";

export type MoveDirection = "up" | "down";

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
}

/**
 * Restores keyboard focus to the moved item's own Move button after a reorder settles (I4).
 * A Move button's `isDisabled` becomes a real `disabled` attribute (the design system's Button
 * wraps React Aria's), and a disabled element can't hold focus — the browser blurs it to
 * `<body>` the instant that happens. That happens two ways here: DocumentsSection disables
 * every Move button for the duration of its per-move save; CarouselScreen/LinksScreen don't
 * save on every move, but moving an item to the very first/last position disables *that same
 * button* (the boundary `index === 0`/`index === length - 1` check) the moment it re-renders at
 * its new position.
 *
 * Fix: never rely on the browser to keep focus — explicitly restore it, by the moved item's own
 * id (an index can't identify it: a move changes every later item's index, which is also what
 * changes its Move button's accessible name). If the moved item's own same-direction button is
 * now the boundary one, fall back to its opposite-direction button.
 */
export function useMoveFocusRestore<T extends HTMLElement = HTMLElement>() {
  const containerRef = useRef<T>(null);
  const pending = useRef<{ id: string; dir: MoveDirection } | null>(null);

  const remember = useCallback((id: string, dir: MoveDirection) => {
    pending.current = { id, dir };
  }, []);

  const restore = useCallback(() => {
    const target = pending.current;
    pending.current = null;
    const container = containerRef.current;
    if (!target || !container) return;
    const find = (dir: MoveDirection) => container.querySelector<HTMLButtonElement>(`[data-move-id="${cssEscape(target.id)}"][data-move-dir="${dir}"] button`);
    const same = find(target.dir);
    const pick = same && !same.disabled ? same : find(target.dir === "up" ? "down" : "up");
    pick?.focus();
  }, []);

  return { containerRef, remember, restore };
}
