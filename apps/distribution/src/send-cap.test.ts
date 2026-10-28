import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createBatch, batchStatus, SEND_CAP_SKIPPED_REASON, type MessageRequest } from "./messages";
import { messages } from "./db/schema";
import { createDistributionTestDb, sampleMessageRequest } from "../test/helpers";

const internalDomains = ["gov.bc.ca"];
const recipients = (n: number): MessageRequest["recipients"] =>
  Array.from({ length: n }, (_, i) => ({ email: `subscriber${i}@example.com`, substitutions: {} }));

describe("createBatch with a test-site send cap (MAIL_REDIRECT_SEND_CAP)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  afterEach(() => vi.restoreAllMocks());

  const rowsOf = (batchId: string) => tdb.db.select().from(messages).where(eq(messages.batchId, batchId));

  it("with the cap on, queues the first N recipients and marks the rest failed with the skip reason; logs one line without addresses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = { ...sampleMessageRequest, recipients: recipients(12) };
    const { batchId } = await createBatch(tdb.db, "nod", req, internalDomains, 5);

    const rows = await rowsOf(batchId);
    const pending = rows.filter((r) => r.status === "pending");
    const skipped = rows.filter((r) => r.status === "failed");
    expect(pending).toHaveLength(5);
    expect(skipped).toHaveLength(7);
    for (const r of skipped) expect(r.lastError).toBe(SEND_CAP_SKIPPED_REASON);
    expect(SEND_CAP_SKIPPED_REASON).toMatch(/^skipped: test-site send cap/);
    // request order is kept: the first five recipients are the ones that stay queued
    expect(pending.map((r) => r.email).sort()).toEqual(recipients(5).map((r) => r.email).sort());
    // the existing counts show the rest as failed rather than losing them
    expect(await batchStatus(tdb.db, batchId, "nod")).toEqual({ id: batchId, total: 12, pending: 5, sent: 0, failed: 7 });

    const lines = [log, warn, info].flatMap((s) => s.mock.calls.map((c) => c.join(" ")));
    const capLines = lines.filter((l) => l.includes("MAIL_REDIRECT_SEND_CAP"));
    expect(capLines).toHaveLength(1);
    expect(capLines[0]).toContain(batchId);
    expect(capLines[0]).toContain("5 of 12 sent (test-site cap MAIL_REDIRECT_SEND_CAP=5)");
    expect(lines.join("\n")).not.toMatch(/@/);
  });

  it("keeps the recipients that would be sent first (highest priority) when the cap bites", async () => {
    const mixed: MessageRequest["recipients"] = [
      ...recipients(4),
      { email: "staffer@gov.bc.ca", substitutions: {} }, // internal domain: priority bump, sent first
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { batchId } = await createBatch(tdb.db, "nod", { ...sampleMessageRequest, recipients: mixed }, internalDomains, 2);
    const pending = (await rowsOf(batchId)).filter((r) => r.status === "pending").map((r) => r.email);
    expect(pending).toContain("staffer@gov.bc.ca");
    expect(pending).toHaveLength(2);
  });

  it("without a cap (real recipients allowed), queues every recipient and logs nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { batchId } = await createBatch(tdb.db, "nod", { ...sampleMessageRequest, recipients: recipients(12) }, internalDomains);
    expect((await rowsOf(batchId)).filter((r) => r.status === "pending")).toHaveLength(12);
    expect(await batchStatus(tdb.db, batchId, "nod")).toMatchObject({ total: 12, pending: 12, failed: 0 });
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("a send at or under the cap (including a single recipient) is unaffected and logs nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const single = await createBatch(tdb.db, "nrms", { ...sampleMessageRequest, recipients: recipients(1) }, internalDomains, 5);
    const exact = await createBatch(tdb.db, "nrms", { ...sampleMessageRequest, recipients: recipients(5) }, internalDomains, 5);
    expect(await batchStatus(tdb.db, single.batchId, "nrms")).toMatchObject({ total: 1, pending: 1, failed: 0 });
    expect(await batchStatus(tdb.db, exact.batchId, "nrms")).toMatchObject({ total: 5, pending: 5, failed: 0 });
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("caps each send separately: two batches of 12 each keep 5", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await createBatch(tdb.db, "nod", { ...sampleMessageRequest, recipients: recipients(12) }, internalDomains, 5);
    const b = await createBatch(tdb.db, "nod", { ...sampleMessageRequest, recipients: recipients(12) }, internalDomains, 5);
    expect(await batchStatus(tdb.db, a.batchId, "nod")).toMatchObject({ pending: 5, failed: 7 });
    expect(await batchStatus(tdb.db, b.batchId, "nod")).toMatchObject({ pending: 5, failed: 7 });
  });
});
