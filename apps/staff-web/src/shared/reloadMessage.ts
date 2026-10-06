/**
 * The one copy of the 409 "someone else changed this" message (constraints.md), shared by
 * every release section (useReleaseSection.ts) and every Website section (useVersionedSave.ts)
 * — both those modules re-export it from here rather than each keeping their own literal, so
 * there's exactly one string to update if the wording ever changes.
 */
export const RELOAD_MESSAGE = "Someone else changed this — reload to see their changes.";
