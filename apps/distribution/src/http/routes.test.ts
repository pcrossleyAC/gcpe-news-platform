import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintLocalToken } from "@gcpe/auth";
import { createDistributionTestDb, sampleMessageRequest } from "../../test/helpers";
import { createApp } from "../app";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://distribution";
const internalDomains = ["gov.bc.ca"];

describe("Distribution HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let sender: string;
  let otherAppSender: string;
  let reader: string;
  let firstBatchId: string;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (azp: string, roles: string[]) =>
      new SignJWT({ roles, azp })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    sender = await sign("nod-client", ["Distribution.Send"]);
    otherAppSender = await sign("other-client", ["Distribution.Send"]);
    reader = await sign("nod-client", []);
    app = createApp({ db: tdb.db, auth: { issuer, audience, keys }, internalDomains });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /health/live needs no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("requires a token, and Distribution.Send role, to post messages", async () => {
    expect((await request(app).post("/api/messages").send(sampleMessageRequest)).status).toBe(401);
    expect((await request(app).post("/api/messages").set("authorization", `Bearer ${reader}`).send(sampleMessageRequest)).status).toBe(403);
  });

  it("creates a batch with correctly prioritised messages, is idempotent per app, and scopes keys per app", async () => {
    const req = { ...sampleMessageRequest, idempotencyKey: "batch-1" };

    const created = await request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(req);
    expect(created.status).toBe(202);
    expect(typeof created.body.batchId).toBe("string");
    firstBatchId = created.body.batchId;

    const { rows: batchRows } = await tdb.pool.query("SELECT app_id FROM batches WHERE id = $1", [firstBatchId]);
    expect(batchRows).toEqual([{ app_id: "nod-client" }]);
    const { rows: messageRows } = await tdb.pool.query(
      "SELECT email, priority, status FROM messages WHERE batch_id = $1 ORDER BY priority",
      [firstBatchId],
    );
    expect(messageRows).toEqual([
      { email: "sam.example@example.com", priority: 30, status: "pending" },
      { email: "alex.example@gov.bc.ca", priority: 32, status: "pending" },
    ]);

    // Same idempotencyKey again, same app -> 200 with the same batchId, no new rows.
    const dup = await request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(req);
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ batchId: firstBatchId });
    const { rows: batchCountAfterDup } = await tdb.pool.query("SELECT count(*)::int FROM batches WHERE app_id = 'nod-client'");
    expect(batchCountAfterDup[0].count).toBe(1);
    const { rows: messageCountAfterDup } = await tdb.pool.query("SELECT count(*)::int FROM messages WHERE batch_id = $1", [firstBatchId]);
    expect(messageCountAfterDup[0].count).toBe(2);

    // Same idempotencyKey, different app (azp) -> a new, separate batch.
    const otherApp = await request(app).post("/api/messages").set("authorization", `Bearer ${otherAppSender}`).send(req);
    expect(otherApp.status).toBe(202);
    expect(otherApp.body.batchId).not.toBe(firstBatchId);
    const { rows: otherAppRows } = await tdb.pool.query("SELECT app_id FROM batches WHERE id = $1", [otherApp.body.batchId]);
    expect(otherAppRows).toEqual([{ app_id: "other-client" }]);
  });

  it("400s an invalid recipient email, zero recipients, and an invalid header name", async () => {
    const badEmail = await request(app)
      .post("/api/messages")
      .set("authorization", `Bearer ${sender}`)
      .send({ ...sampleMessageRequest, recipients: [{ email: "not-an-email", substitutions: {} }] });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error).toBe("invalid request");
    expect(Array.isArray(badEmail.body.issues)).toBe(true);

    const noRecipients = await request(app)
      .post("/api/messages")
      .set("authorization", `Bearer ${sender}`)
      .send({ ...sampleMessageRequest, recipients: [] });
    expect(noRecipients.status).toBe(400);

    const badHeader = await request(app)
      .post("/api/messages")
      .set("authorization", `Bearer ${sender}`)
      .send({ ...sampleMessageRequest, headers: { "X-Evil:": "1" } });
    expect(badHeader.status).toBe(400);
  });

  // M3: the body limit was raised from 5mb to 10mb (apps/distribution/src/app.ts) so a batch
  // whose JSON payload is over the old limit but under the new one is no longer rejected.
  it("accepts a request body over the old 5mb limit but under the new 10mb one", async () => {
    const html = `<p>${"x".repeat(7 * 1024 * 1024)}</p>`;
    const res = await request(app)
      .post("/api/messages")
      .set("authorization", `Bearer ${sender}`)
      .send({ ...sampleMessageRequest, idempotencyKey: "big-body-1", html });
    expect(res.status).toBe(202);
  });

  it("two posts with no idempotencyKey each create their own batch", async () => {
    const { idempotencyKey: _ignored, ...withoutKey } = sampleMessageRequest as typeof sampleMessageRequest & { idempotencyKey?: string };
    const first = await request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(withoutKey);
    const second = await request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(withoutKey);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.batchId).not.toBe(second.body.batchId);

    const { rows } = await tdb.pool.query("SELECT count(*)::int FROM batches WHERE id = ANY($1) AND idempotency_key IS NULL", [
      [first.body.batchId, second.body.batchId],
    ]);
    expect(rows[0].count).toBe(2);
  });

  it("GET /api/batches/:id returns batch counts, 404s an unknown uuid and a non-uuid", async () => {
    const res = await request(app).get(`/api/batches/${firstBatchId}`).set("authorization", `Bearer ${sender}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: firstBatchId, total: 2, pending: 2, sent: 0, failed: 0 });

    const unknown = await request(app)
      .get("/api/batches/00000000-0000-0000-0000-000000000000")
      .set("authorization", `Bearer ${sender}`);
    expect(unknown.status).toBe(404);

    const notUuid = await request(app).get("/api/batches/not-a-uuid").set("authorization", `Bearer ${sender}`);
    expect(notUuid.status).toBe(404);
  });

  // M2: a batch belonging to a different app must 404, not leak its status.
  it("404s GET /api/batches/:id for a batch belonging to a different app", async () => {
    const res = await request(app).get(`/api/batches/${firstBatchId}`).set("authorization", `Bearer ${otherAppSender}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("two concurrent posts with the same idempotencyKey produce exactly one batch row", async () => {
    const req = { ...sampleMessageRequest, idempotencyKey: "concurrent-1" };
    const [a, b] = await Promise.all([
      request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(req),
      request(app).post("/api/messages").set("authorization", `Bearer ${sender}`).send(req),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.batchId).toBe(b.body.batchId);

    const { rows } = await tdb.pool.query("SELECT count(*)::int FROM batches WHERE app_id = 'nod-client' AND idempotency_key = 'concurrent-1'");
    expect(rows[0].count).toBe(1);
  });

  // NoD (Task 10) authenticates with a local service token rather than Entra; this proves
  // that path works end to end, with the batch's app_id taken from the token's own azp.
  it("local service token (as NoD will use): a valid token sends a batch with app_id from azp", async () => {
    const secret = "y".repeat(40) + "-distribution-local-test";
    const localApp = createApp({ db: tdb.db, auth: { local: { secret } }, internalDomains });
    const token = await mintLocalToken({ secret, subject: "nod", azp: "nod", roles: ["Distribution.Send"] });

    const res = await request(localApp)
      .post("/api/messages")
      .set("authorization", `Bearer ${token}`)
      .send({ ...sampleMessageRequest, idempotencyKey: "nod-batch-1" });
    expect(res.status).toBe(202);

    const { rows } = await tdb.pool.query("SELECT app_id FROM batches WHERE id = $1", [res.body.batchId]);
    expect(rows).toEqual([{ app_id: "nod" }]);
  });
});
