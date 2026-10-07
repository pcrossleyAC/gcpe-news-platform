import type { Db } from "@gcpe/db-kit";
import type { DistributionClient } from "./distribution-client";
import { getEmergencyFeedStatus, type EmergencyFeedStatus } from "./emergency/ingest";
import { getPurgeStatus, type PurgeStatus } from "./purge";
import { getSettings, getSoftCodesCounted, resolveBounceSummaryAddress, type BounceSummaryAddress } from "./settings";
import { safeErrorLabel } from "./subscribe/journeys";

/** Everything the staff Operations screen shows (spec §8), in one read. */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  /** Null when Distribution didn't answer: the screen says so, and NoD's own controls still work. */
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: BounceSummaryAddress;
  softCodesCounted: string[];
  purge: PurgeStatus;
  emergencyFeed: EmergencyFeedStatus;
}

export interface OperationsOptions {
  bounceSummaryFallback: string | null;
  timeZone: string;
  emergencyFeedUrl: string | null;
}

export async function getOperations(
  db: Db,
  distribution: Pick<DistributionClient, "getSettings" | "bounceSource">,
  opts: OperationsOptions,
): Promise<OperationsStatus> {
  const [nod, bounceSummary, dist, bounceSource, softCodesCounted, purge, emergencyFeed] = await Promise.all([
    getSettings(db),
    resolveBounceSummaryAddress(db, opts.bounceSummaryFallback),
    distribution.getSettings().then(
      (s) => ({ paused: s.paused }),
      (e: unknown) => {
        console.error("[nod] operations: Distribution settings unavailable", safeErrorLabel(e));
        return null;
      },
    ),
    distribution.bounceSource().then(
      (s) => s.source,
      (e: unknown) => {
        console.error("[nod] operations: bounce source unavailable", safeErrorLabel(e));
        return null;
      },
    ),
    getSoftCodesCounted(db),
    getPurgeStatus(db, opts.timeZone),
    getEmergencyFeedStatus(db, opts.emergencyFeedUrl),
  ]);
  return { nod, distribution: dist, bounceSource, bounceSummary, softCodesCounted, purge, emergencyFeed };
}
