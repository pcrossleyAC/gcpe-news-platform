import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { enqueueEvent, type ReleaseStatusChanged, type SubscriberConfig } from "@gcpe/events";
import { LANG_EN, type ReleaseStatus, type ReleaseType } from "@gcpe/nrms-contract";
import { documentLanguages, newsReleases, releaseDocuments } from "../db/schema";

/** What the Calendar keeps of a release (spec addendum §5.2 `release_links`). */
export interface LinkState {
  releaseId: string;
  key: string | null;
  reference: string | null;
  type: ReleaseType;
  activityId: number | null;
  status: ReleaseStatus;
  publishAt: string | null;
  releasedAt: string | null;
  headline: string | null;
}

export async function linkStateOf(tx: DbOrTx, releaseId: string): Promise<LinkState | null> {
  const [r] = await tx
    .select({
      key: newsReleases.key, reference: newsReleases.reference, type: newsReleases.type, activityId: newsReleases.activityId, status: newsReleases.status,
      publishAt: newsReleases.publishAt, releasedAt: newsReleases.releasedAt,
    })
    .from(newsReleases)
    .where(eq(newsReleases.id, releaseId));
  if (!r) return null;
  const [first] = await tx
    .select({ headline: documentLanguages.headline })
    .from(releaseDocuments)
    .innerJoin(documentLanguages, and(eq(documentLanguages.documentId, releaseDocuments.id), eq(documentLanguages.languageId, LANG_EN)))
    .where(eq(releaseDocuments.releaseId, releaseId))
    .orderBy(asc(releaseDocuments.sortIndex))
    .limit(1);
  return {
    releaseId, key: r.key, reference: r.reference, type: r.type, activityId: r.activityId, status: r.status,
    publishAt: r.publishAt?.toISOString() ?? null, releasedAt: r.releasedAt?.toISOString() ?? null, headline: first?.headline ?? null,
  };
}

/**
 * The status the Calendar shows. A correction (publishing) or an unpublish (unpublishing) in
 * progress is still on the site, so it reads as published until the publisher settles it.
 */
export function settledStatus(status: ReleaseStatus): ReleaseStatus {
  return status === "publishing" || status === "unpublishing" ? "published" : status;
}

/** The fields the Calendar shows. The key and headline travel with each event but don't cause one. */
const shown = (s: LinkState) => [s.activityId, settledStatus(s.status), s.publishAt, s.releasedAt, s.reference, s.type].join("|");

export function statusChangedData(now: LinkState, previousActivityId: number | null): ReleaseStatusChanged {
  return {
    releaseId: now.releaseId, key: now.key, reference: now.reference, type: now.type, activityId: now.activityId, previousActivityId,
    status: settledStatus(now.status), publishAt: now.publishAt, releasedAt: now.releasedAt, headline: now.headline,
  };
}

export async function sendStatusChanged(tx: DbOrTx, data: ReleaseStatusChanged, subscribers: SubscriberConfig[]): Promise<void> {
  await enqueueEvent(tx, { type: "release.status_changed", source: "nrms", aggregateId: `release:${data.releaseId}`, data }, subscribers);
}

/**
 * In the write's own transaction: sends release.status_changed when the write moved what the
 * Calendar shows of a release linked, before or after, to an activity. `after` null is a release
 * deleted for good. Ordering per release is the event's sequence on `release:<id>`.
 */
export async function emitLinkChange(tx: DbOrTx, before: LinkState | null, after: LinkState | null, subscribers: SubscriberConfig[]): Promise<void> {
  const now: LinkState | null = after ?? (before && { ...before, status: "deleted" });
  if (!now) return;
  const previous = before?.activityId ?? null;
  if (now.activityId === null && previous === null) return;
  if (before && shown(before) === shown(now)) return;
  await sendStatusChanged(tx, statusChangedData(now, previous !== now.activityId ? previous : null), subscribers);
}
