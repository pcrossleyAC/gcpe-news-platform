import type { ManualPage, ManualsData } from "../../../../scripts/manuals-lib.mjs";
import type { SessionValue } from "../session/SessionContext";
import { visibleManuals } from "./catalog";
import generated from "./manuals.generated.json";

/** The compiled manual pages (committed, refreshed by `npm run manuals:build`). */
export const MANUALS_DATA = generated as ManualsData;

export function canOpenManual(manualId: string, s: SessionValue): boolean {
  return (visibleManuals(s) as string[]).includes(manualId);
}

/**
 * Every page this reader may open: the pages of their visible manuals (in that order, so their own
 * manual comes first), then the topic pages that a page they can see lists in `topics`, followed
 * through topic pages too.
 */
export function visiblePages(data: ManualsData, s: SessionValue): ManualPage[] {
  const manuals = visibleManuals(s);
  const out = manuals.flatMap((m) => data.pages.filter((p) => p.manual === m));
  const topics = data.pages.filter((p) => p.manual === "topic");
  const shown = new Set<string>();
  let frontier = out;
  while (frontier.length > 0) {
    const next = topics.filter((t) => !shown.has(t.id) && frontier.some((p) => p.topics.includes(t.id)));
    next.forEach((t) => shown.add(t.id));
    frontier = next;
  }
  return [...out, ...topics.filter((t) => shown.has(t.id))];
}

/** The page at /help/manuals/<manualId>/<pageId> when this reader may open it, else null. */
export function openablePage(data: ManualsData, manualId: string, pageId: string, s: SessionValue): ManualPage | null {
  return visiblePages(data, s).find((p) => p.manual === manualId && p.id === pageId) ?? null;
}

export function canOpenPage(data: ManualsData, manualId: string, pageId: string, s: SessionValue): boolean {
  return openablePage(data, manualId, pageId, s) !== null;
}
