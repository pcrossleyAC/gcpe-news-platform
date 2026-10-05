/**
 * Pure ordering helpers for the Documents section (task-4-brief.md): both the drag-and-drop
 * reorder and the keyboard "Move up"/"Move down" buttons end up calling the same
 * `PUT .../documents/order {version, documentIds}` with a full ordering of every document id —
 * so both paths compute that same full list here, rather than each inventing their own.
 */

/** The document ids in `sortIndex` order — what `documentIds` must start as before any move. */
export function orderedIds(documents: { id: string; sortIndex: number }[]): string[] {
  return [...documents].sort((a, b) => a.sortIndex - b.sortIndex).map((d) => d.id);
}

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
