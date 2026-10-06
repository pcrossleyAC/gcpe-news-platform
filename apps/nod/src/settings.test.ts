import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import type { DistributionClient, MessageRequest } from "./distribution-client";
import { jobRecipients, nodSettings, operationsLog, sendJobs, subscribers } from "./db/schema";
import type { RecipientLinkOptions } from "./recipient-links";
import type { RenderOptions } from "./render";
import { sendDueJobs } from "./send-jobs";
import { getSettings, setPaused, type SetPausedDeps } from "./settings";

const RENDER: RenderOptions = { siteUrl: "https://news.example/site", bannerUrl: null };
const LINKS: RecipientLinkOptions = {
  pageUrl: "https://news.example/subscribe/manage",
  subscribeApiUrl: "https://news.example/api/Subscribe",
  linkSecret: "test-link-secret-at-least-32-chars-long",
};
const TIME_ZONE = "America/Vancouver";

function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ batchId: "batch-ops" }) } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn> };
}

describe("settings", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE operations_log, send_jobs, job_recipients, subscribers CASCADE");
    await tdb.pool.query("UPDATE nod_settings SET paused = false");
  });

  function deps(overrides: Partial<SetPausedDeps> = {}): SetPausedDeps {
    const distribution = overrides.distribution ?? stubDistribution();
    return { db: tdb.db, distribution, opsEmail: "ops@example.com", timeZone: TIME_ZONE, ...overrides };
  }

  it("getSettings reflects the singleton row", async () => {
    expect(await getSettings(tdb.db)).toEqual({ paused: false, lastDigestCutoff: null });
    await tdb.pool.query("UPDATE nod_settings SET paused = true, last_digest_cutoff = '2026-10-05T17:00:00Z'");
    expect(await getSettings(tdb.db)).toEqual({ paused: true, lastDigestCutoff: "2026-10-05T17:00:00.000Z" });
  });

  it("pause: sets paused, writes one operations_log row and sends one ops email; a repeat pause changes nothing", async () => {
    const distribution = stubDistribution();
    const result = await setPaused(deps({ distribution }), true, "Jamie Admin");
    expect(result).toEqual({ changed: true });

    const [settingsRow] = await tdb.db.select().from(nodSettings);
    expect(settingsRow!.paused).toBe(true);

    const logRows = await tdb.db.select().from(operationsLog);
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.actor).toBe("Jamie Admin");
    expect(logRows[0]!.action).toBe("paused");

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.priority).toBe("system");
    expect(req.idempotencyKey).toBe(`nod-ops-${logRows[0]!.id}`);
    expect(req.subject).toBe("BC Gov News On Demand sending paused");
    expect(req.recipients).toEqual([{ email: "ops@example.com", substitutions: {} }]);
    expect(req.text).toContain("Jamie Admin");
    expect(req.text).toContain("paused");

    // Repeat pause: already paused -- no new log row, no second email, changed: false.
    const again = await setPaused(deps({ distribution }), true, "Someone Else");
    expect(again).toEqual({ changed: false });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("resume: sets paused false, writes one operations_log row and sends one ops email; a repeat resume changes nothing", async () => {
    await tdb.pool.query("UPDATE nod_settings SET paused = true");
    const distribution = stubDistribution();

    const result = await setPaused(deps({ distribution }), false, "Jamie Admin");
    expect(result).toEqual({ changed: true });

    const [settingsRow] = await tdb.db.select().from(nodSettings);
    expect(settingsRow!.paused).toBe(false);

    const logRows = await tdb.db.select().from(operationsLog);
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.action).toBe("resumed");

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.subject).toBe("BC Gov News On Demand sending resumed");
    expect(req.idempotencyKey).toBe(`nod-ops-${logRows[0]!.id}`);

    const again = await setPaused(deps({ distribution }), false, "Jamie Admin");
    expect(again).toEqual({ changed: false });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("no ops email configured: writes the log row but sends no email", async () => {
    const distribution = stubDistribution();
    const result = await setPaused(deps({ distribution, opsEmail: null }), true, "Jamie Admin");
    expect(result).toEqual({ changed: true });

    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);
    expect(distribution.send).not.toHaveBeenCalled();
  });

  it("ops email fails: the call still resolves with changed: true, and the log row stands", async () => {
    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new Error("Distribution unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await setPaused(deps({ distribution }), true, "Jamie Admin");
      expect(result).toEqual({ changed: true });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain("ops email");
    } finally {
      errorSpy.mockRestore();
    }
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);
    const [settingsRow] = await tdb.db.select().from(nodSettings);
    expect(settingsRow!.paused).toBe(true);
  });

  // Global constraint ("Held, not dropped"): a job created while paused is still pending after
  // sendDueJobs, and is sent once setPaused resumes sending -- this is the same nod_settings
  // row both setPaused and sendDueJobs (Task 4) read/write, exercised end to end.
  it("a job created while paused is held, not dropped, and is sent after resume", async () => {
    const [sub] = await tdb.db.insert(subscribers).values({ email: "held@example.com", verifiedAt: new Date(), status: "active" }).returning();
    await setPaused(deps({ opsEmail: null }), true, "Jamie Admin");

    const [job] = await tdb.db
      .insert(sendJobs)
      .values({ jobKey: "as_it_happens:release-held", itemKey: "release-held", subject: "Clinics open", html: "<p>hi</p>", text: "hi" })
      .returning();
    await tdb.db.insert(jobRecipients).values({ jobId: job!.id, subscriberId: sub!.id });

    const distribution = stubDistribution();
    const pausedResult = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(pausedResult).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: true });
    expect(distribution.send).not.toHaveBeenCalled();
    const stillPending = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job!.id)))[0]!;
    expect(stillPending.status).toBe("pending");

    await setPaused(deps({ distribution, opsEmail: null }), false, "Jamie Admin");
    const resumedResult = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(resumedResult).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });
    const sent = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job!.id)))[0]!;
    expect(sent.status).toBe("sent");
  });
});
