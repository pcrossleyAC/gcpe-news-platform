import type { Db } from "@gcpe/db-kit";
import type { DistributionClient } from "./distribution-client";
import { getEmergencyFeedStatus, type EmergencyFeedStatus } from "./emergency/ingest";
import { getOutgoing, type OutgoingStatus } from "./outgoing";
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
  /** `switchedOff`: NOD_EMERGENCY_FEED=off, set on purpose (owner decision 2026-10-31, option C). */
  emergencyFeed: EmergencyFeedStatus & { switchedOff: boolean };
  /** @gcpe/config's isTestSite: the screen warns on real production that bounces aren't read. */
  testSite: boolean;
  /** Whether a pause or resume emails an operations inbox (NOD_OPS_EMAIL); never the address. */
  opsEmailSet: boolean;
  /** Held and failed news email (N3). */
  outgoing: OutgoingStatus;
}

export interface OperationsOptions {
  bounceSummaryFallback: string | null;
  timeZone: string;
  emergencyFeedUrl: string | null;
  /** NOD_EMERGENCY_FEED=off. */
  emergencyFeedOff: boolean;
  testSite: boolean;
  opsEmail: string | null;
}

export async function getOperations(
  db: Db,
  distribution: Pick<DistributionClient, "getSettings" | "bounceSource">,
  opts: OperationsOptions,
): Promise<OperationsStatus> {
  const [nod, bounceSummary, dist, bounceSource, softCodesCounted, purge, emergencyFeed, outgoing] = await Promise.all([
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
    getOutgoing(db),
  ]);
  return {
    nod,
    distribution: dist,
    bounceSource,
    bounceSummary,
    softCodesCounted,
    purge,
    emergencyFeed: { ...emergencyFeed, switchedOff: opts.emergencyFeedOff },
    testSite: opts.testSite,
    opsEmailSet: Boolean(opts.opsEmail),
    outgoing,
  };
}
