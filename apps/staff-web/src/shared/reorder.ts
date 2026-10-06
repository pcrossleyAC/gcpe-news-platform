/**
 * Generic, id-based ordering helpers (I3 minor: previously lived under
 * screens/release/documents/reorder.ts even though CarouselScreen/LinksScreen's own
 * screens/website/reorder.ts already depended on them — moved here so every reorderable list,
 * release or Website, shares one copy). Both the drag-and-drop reorder and the keyboard
 * "Move up"/"Move down" buttons end up computing the same full ordering by calling these, then
 * send that whole order in one PUT.
 */

/** Moves the id at `index` one slot earlier/later; a no-op at either end (returns the same
 * array's values in a new array, never throws on an out-of-range move). */
export function moveBy(ids: string[], index: number, delta: 1 | -1): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  const [removed] = next.splice(index, 1);
  next.splice(target, 0, removed!);
  return next;
}

/** Moves the id at `from` to sit at `to` (drag-and-drop drop target), clamping `to` into range. */
export function moveTo(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const clampedTo = Math.max(0, Math.min(ids.length - 1, to));
  const next = [...ids];
  const [removed] = next.splice(from, 1);
  next.splice(clampedTo, 0, removed!);
  return next;
}
