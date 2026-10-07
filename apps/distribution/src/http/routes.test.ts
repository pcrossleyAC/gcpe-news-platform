import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintLocalToken } from "@gcpe/auth";
import { createDistributionTestDb, sampleMessageRequest } from "../../test/helpers";
import { bounces } from "../db/schema";
import { createApp } from "../app";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://distribution";
const internalDomains = ["gov.bc.ca"];

describe("Distribution HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let graphModeApp: ReturnType<typeof createApp>;
  let sender: string;
  let otherAppSender: string;
  let reader: string;
  let operator: string;
  let firstBatchId: string;
  let appidOnlySender: string;

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
    operator = await sign("nod", ["Distribution.Operate"]);
    // An Entra v1 access token: the client id arrives as `appid`, never `azp`.
    appidOnlySender = await new SignJWT({ roles: ["Distribution.Send"], appid: "v1-client" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("svc-v1-object-id")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    app = createApp({ db: tdb.db, auth: { issuer, audience, keys }, internalDomains });
    graphModeApp = createApp({ db: tdb.db, auth: { issuer, audience, keys }, internalDomains, bounceSource: "graph" });
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

  describe("attachments", () => {
    const pdf = { filename: "DRAFT-release.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 tiny").toString("base64") };
    const postWith = (attachments: unknown[], idempotencyKey?: string) =>
      request(app)
        .post("/api/messages")
        .set("authorization", `Bearer ${sender}`)
        .send({ ...sampleMessageRequest, ...(idempotencyKey ? { idempotencyKey } : {}), attachments });

    it("accepts a message with one PDF attachment and stores it on the batch", async () => {
      const res = await postWith([pdf], "attach-1");
      expect(res.status).toBe(202);
      const { rows } = await tdb.pool.query("SELECT attachments FROM batches WHERE id = $1", [res.body.batchId]);
      expect(rows[0].attachments).toEqual([pdf]);
    });

    it("a message without attachments stores an empty list", async () => {
      const res = await postWith([], "attach-none");
      expect(res.status).toBe(202);
      const { rows } = await tdb.pool.query("SELECT attachments FROM batches WHERE id = $1", [res.body.batchId]);
      expect(rows[0].attachments).toEqual([]);
    });

    it("400s more than 3 attachments, a filename with a slash, an unsupported type, and non-base64 content", async () => {
      expect((await postWith([pdf, pdf, pdf, pdf])).status).toBe(400);
      expect((await postWith([{ ...pdf, filename: "../etc/passwd.pdf" }])).status).toBe(400);
      expect((await postWith([{ ...pdf, filename: 'a".pdf' }])).status).toBe(400);
      expect((await postWith([{ ...pdf, contentType: "text/html" }])).status).toBe(400);
      expect((await postWith([{ ...pdf, contentBase64: "not base64!" }])).status).toBe(400);
    });

    it("400s attachments whose decoded total is over 7 MiB (and accepts exactly 7 MiB)", async () => {
      const over = Buffer.alloc(7 * 1024 * 1024 + 1, 1).toString("base64");
      const res = await postWith([{ ...pdf, contentBase64: over }]);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.issues)).toContain("attachments exceed 7 MiB");

      const half = Buffer.alloc(3.5 * 1024 * 1024, 1).toString("base64");
      expect((await postWith([{ ...pdf, contentBase64: half }, { ...pdf, contentBase64: half }], "attach-7mib")).status).toBe(202);
    });
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

  // ruling: an Entra v1 access token carries the client id in `appid`, not `azp` -- without
  // the fallback, this would record the batch under the service principal's own object id
  // (the subject), and NoD would never recognise it as its own appId in a delivery.bounced
  // event.
  it("an Entra v1 token with no azp but an appid claim sends a batch with app_id from appid", async () => {
    const res = await request(app)
      .post("/api/messages")
      .set("authorization", `Bearer ${appidOnlySender}`)
      .send({ ...sampleMessageRequest, idempotencyKey: "appid-only-1" });
    expect(res.status).toBe(202);

    const { rows } = await tdb.pool.query("SELECT app_id FROM batches WHERE id = $1", [res.body.batchId]);
    expect(rows).toEqual([{ app_id: "v1-client" }]);
  });

  describe("GET /api/settings, POST /api/settings/pause|resume", () => {
    afterAll(async () => {
      await tdb.pool.query("UPDATE distribution_settings SET paused = false");
    });

    it("401s without a token, 403s without Distribution.Operate, for all three routes", async () => {
      expect((await request(app).get("/api/settings")).status).toBe(401);
      expect((await request(app).get("/api/settings").set("authorization", `Bearer ${reader}`)).status).toBe(403);
      expect((await request(app).post("/api/settings/pause")).status).toBe(401);
      expect((await request(app).post("/api/settings/pause").set("authorization", `Bearer ${reader}`)).status).toBe(403);
      expect((await request(app).post("/api/settings/resume")).status).toBe(401);
      expect((await request(app).post("/api/settings/resume").set("authorization", `Bearer ${reader}`)).status).toBe(403);
      // Distribution.Send (the message-sending role) isn't Distribution.Operate either.
      expect((await request(app).get("/api/settings").set("authorization", `Bearer ${sender}`)).status).toBe(403);
    });

    it("GET /api/settings returns the current paused shape", async () => {
      const res = await request(app).get("/api/settings").set("authorization", `Bearer ${operator}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ paused: false });
    });

    it("pauses, then resumes; a repeat pause reports changed: false", async () => {
      const pause = await request(app).post("/api/settings/pause").set("authorization", `Bearer ${operator}`);
      expect(pause.status).toBe(200);
      expect(pause.body).toEqual({ paused: true, changed: true });

      const settingsAfterPause = await request(app).get("/api/settings").set("authorization", `Bearer ${operator}`);
      expect(settingsAfterPause.body).toEqual({ paused: true });

      const pauseAgain = await request(app).post("/api/settings/pause").set("authorization", `Bearer ${operator}`);
      expect(pauseAgain.status).toBe(200);
      expect(pauseAgain.body).toEqual({ paused: true, changed: false });

      const resume = await request(app).post("/api/settings/resume").set("authorization", `Bearer ${operator}`);
      expect(resume.status).toBe(200);
      expect(resume.body).toEqual({ paused: false, changed: true });

      const resumeAgain = await request(app).post("/api/settings/resume").set("authorization", `Bearer ${operator}`);
      expect(resumeAgain.body).toEqual({ paused: false, changed: false });

      const settingsAfterResume = await request(app).get("/api/settings").set("authorization", `Bearer ${operator}`);
      expect(settingsAfterResume.body).toEqual({ paused: false });
    });
  });

  describe("POST /api/bounces/inbox, GET /api/bounces/source", () => {
    it("401s without a token, 403s without Distribution.Operate", async () => {
      expect((await request(app).post("/api/bounces/inbox").send({ raw: "x" })).status).toBe(401);
      expect((await request(app).post("/api/bounces/inbox").set("authorization", `Bearer ${reader}`).send({ raw: "x" })).status).toBe(403);
      expect((await request(app).get("/api/bounces/source")).status).toBe(401);
      expect((await request(app).get("/api/bounces/source").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    });

    it("GET /api/bounces/source reports fake for this app", async () => {
      const res = await request(app).get("/api/bounces/source").set("authorization", `Bearer ${operator}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ source: "fake" });
    });

    it("201s a valid upload and stores the raw message in bounce_inbox", async () => {
      const res = await request(app).post("/api/bounces/inbox").set("authorization", `Bearer ${operator}`).send({ raw: "Subject: Undeliverable: x\r\n\r\nbody" });
      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe("string");

      const { rows } = await tdb.pool.query("SELECT raw, processed_at FROM bounce_inbox WHERE id = $1", [res.body.id]);
      expect(rows).toEqual([{ raw: "Subject: Undeliverable: x\r\n\r\nbody", processed_at: null }]);
    });

    it("400s a missing raw field and a raw over 1 MB", async () => {
      expect((await request(app).post("/api/bounces/inbox").set("authorization", `Bearer ${operator}`).send({})).status).toBe(400);
      const over = "x".repeat(1024 * 1024 + 1);
      expect((await request(app).post("/api/bounces/inbox").set("authorization", `Bearer ${operator}`).send({ raw: over })).status).toBe(400);
    });

    it("404s the upload route (even with Distribution.Operate) when this app reports BOUNCE_SOURCE=graph, but still reports its source", async () => {
      const upload = await request(graphModeApp).post("/api/bounces/inbox").set("authorization", `Bearer ${operator}`).send({ raw: "x" });
      expect(upload.status).toBe(404);

      const source = await request(graphModeApp).get("/api/bounces/source").set("authorization", `Bearer ${operator}`);
      expect(source.status).toBe(200);
      expect(source.body).toEqual({ source: "graph" });
    });
  });

  describe("GET /api/bounces/stats", () => {
    const sourceId = (n: number) => `stats-src-${n}`;
    const q = (since: string, until: string) => `/api/bounces/stats?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;

    it("401s without a token, 403s without Distribution.Operate", async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const until = new Date().toISOString();
      expect((await request(app).get(q(since, until))).status).toBe(401);
      expect((await request(app).get(q(since, until)).set("authorization", `Bearer ${reader}`)).status).toBe(403);
    });

    it("400s a missing or invalid since/until", async () => {
      const until = new Date().toISOString();
      expect((await request(app).get("/api/bounces/stats").set("authorization", `Bearer ${operator}`)).status).toBe(400);
      expect((await request(app).get(`/api/bounces/stats?since=not-a-date&until=${until}`).set("authorization", `Bearer ${operator}`)).status).toBe(400);
      expect((await request(app).get(`/api/bounces/stats?since=${until}`).set("authorization", `Bearer ${operator}`)).status).toBe(400); // until missing
      expect((await request(app).get(`/api/bounces/stats?since=${until}&until=not-a-date`).set("authorization", `Bearer ${operator}`)).status).toBe(400);
    });

    it("counts unmatched bounces and ignored messages processed in (since, until], excluding matched bounces and anything outside it", async () => {
      const since = new Date();
      const until = new Date(since.getTime() + 10_000);
      await tdb.db.insert(bounces).values([
        // Before the window -- excluded no matter its kind/matched state.
        { sourceId: sourceId(1), raw: "x", kind: "bounce", matched: false, processedAt: new Date(since.getTime() - 60_000) },
        // Inside the window: an unmatched hard bounce (counts), a matched one (doesn't), and
        // two ignored (non-bounce) messages (count as ignored, not unmatched).
        { sourceId: sourceId(2), raw: "x", kind: "bounce", matched: false, processedAt: new Date(since.getTime() + 1_000) },
        { sourceId: sourceId(3), raw: "x", kind: "bounce", matched: true, processedAt: new Date(since.getTime() + 2_000) },
        { sourceId: sourceId(4), raw: "x", kind: "ignored", matched: false, processedAt: new Date(since.getTime() + 3_000) },
        { sourceId: sourceId(5), raw: "x", kind: "ignored", matched: false, processedAt: new Date(since.getTime() + 4_000) },
        // After the window -- excluded, same as a row before it (prevents double-counting
        // across two successive summaries whose windows abut).
        { sourceId: sourceId(6), raw: "x", kind: "bounce", matched: false, processedAt: new Date(since.getTime() + 20_000) },
      ]);

      const res = await request(app).get(q(since.toISOString(), until.toISOString())).set("authorization", `Bearer ${operator}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ unmatched: 1, ignored: 2 });
    });

    it("zero counts when nothing was processed in the given window", async () => {
      const since = new Date(Date.now() + 364 * 24 * 3_600_000).toISOString();
      const until = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();
      const res = await request(app).get(q(since, until)).set("authorization", `Bearer ${operator}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ unmatched: 0, ignored: 0 });
    });
  });
});
