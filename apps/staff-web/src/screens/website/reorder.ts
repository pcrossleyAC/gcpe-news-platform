/**
 * Generic index-based reorder helpers, shared by every Website list editor that needs both
 * drag-and-drop and the keyboard-operable Move up/down buttons (constraints.md) to agree on the
 * same resulting order: CarouselScreen's slides and LinksScreen's links. Built on top of
 * shared/reorder.ts's id-based `moveBy`/`moveTo` (rather than duplicating their splice logic)
 * by treating each item's own array index as its "id" for that call.
 */
import { moveBy, moveTo } from "../../shared/reorder";

/** Moves the item at `index` one slot earlier/later; a no-op at either end. */
export function moveItemBy<T>(items: T[], index: number, delta: 1 | -1): T[] {
  const keys = items.map((_, i) => String(i));
  return moveBy(keys, index, delta).map((k) => items[Number(k)]!);
}

/** Moves the item at `from` to sit at `to` (a drag-and-drop drop target), clamping `to` into range. */
export function moveItemTo<T>(items: T[], from: number, to: number): T[] {
  const keys = items.map((_, i) => String(i));
  return moveTo(keys, from, to).map((k) => items[Number(k)]!);
}
