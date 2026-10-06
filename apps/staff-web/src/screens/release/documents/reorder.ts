/**
 * Documents-specific ordering helper (task-4-brief.md). The generic, id-based `moveBy`/`moveTo`
 * both the drag reorder and the keyboard Move up/down buttons build on now live in
 * `shared/reorder.ts` (I3 minor) — this file keeps only what's specific to a document list:
 * turning its `sortIndex` field into the plain id ordering those helpers expect.
 */

/** The document ids in `sortIndex` order — what `documentIds` must start as before any move. */
export function orderedIds(documents: { id: string; sortIndex: number }[]): string[] {
  return [...documents].sort((a, b) => a.sortIndex - b.sortIndex).map((d) => d.id);
}
