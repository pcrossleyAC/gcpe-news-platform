import type { Db } from "@gcpe/db-kit";
import type { DistributionClient } from "./distribution-client";
import { getSettings, resolveBounceSummaryAddress, type BounceSummaryAddress } from "./settings";
import { safeErrorLabel } from "./subscribe/journeys";

/** Everything the staff Operations screen shows (spec §8), in one read. */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  /** Null when Distribution didn't answer: the screen says so, and NoD's own controls still work. */
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: BounceSummaryAddress;
}

export async function getOperations(
  db: Db,
  distribution: Pick<DistributionClient, "getSettings" | "bounceSource">,
  bounceSummaryFallback: string | null,
): Promise<OperationsStatus> {
  const [nod, bounceSummary, dist, bounceSource] = await Promise.all([
    getSettings(db),
    resolveBounceSummaryAddress(db, bounceSummaryFallback),
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
  ]);
  return { nod, distribution: dist, bounceSource, bounceSummary };
}
