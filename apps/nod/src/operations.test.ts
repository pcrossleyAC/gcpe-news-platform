import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { nodSettings, operationsLog } from "./db/schema";
import type { DistributionClient } from "./distribution-client";
import { getOperations } from "./operations";
import { resolveBounceSummaryAddress, setBounceSummaryAddress } from "./settings";

describe("operations", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: null, paused: false }).where(eq(nodSettings.id, 1));
    await tdb.db.delete(operationsLog);
  });

  it("the summary address: stored setting first, then the server default, else none", async () => {
    expect(await resolveBounceSummaryAddress(tdb.db, null)).toEqual({ address: null, from: null });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "server@example.test", from: "server" });
    expect(await setBounceSummaryAddress(tdb.db, "staff@example.test", "Avery")).toEqual({ changed: true });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "staff@example.test", from: "setting" });
    expect(await setBounceSummaryAddress(tdb.db, "staff@example.test", "Avery")).toEqual({ changed: false });
    expect(await setBounceSummaryAddress(tdb.db, null, "Avery")).toEqual({ changed: true });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "server@example.test", from: "server" });
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.action, l.detail])).toEqual([["bounce-summary-address-changed", "set"], ["bounce-summary-address-changed", "cleared"]]);
    expect(JSON.stringify(log)).not.toContain("@");
  });

  it("Distribution down: NoD's own state still comes back; Distribution's is null; nothing logs an address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribution = {
      getSettings: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED ops@example.test")),
      bounceSource: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as Pick<DistributionClient, "getSettings" | "bounceSource">;
    const ops = await getOperations(tdb.db, distribution, "server@example.test");
    expect(ops).toEqual({
      nod: { paused: false, lastDigestCutoff: null },
      distribution: null,
      bounceSource: null,
      bounceSummary: { address: "server@example.test", from: "server" },
      softCodesCounted: [],
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("@");
    spy.mockRestore();
  });

  it("Distribution up: its pause state and bounce source", async () => {
    const distribution = {
      getSettings: vi.fn().mockResolvedValue({ paused: true }),
      bounceSource: vi.fn().mockResolvedValue({ source: "fake" }),
    } as unknown as Pick<DistributionClient, "getSettings" | "bounceSource">;
    expect(await getOperations(tdb.db, distribution, null)).toMatchObject({ distribution: { paused: true }, bounceSource: "fake" });
  });
});
