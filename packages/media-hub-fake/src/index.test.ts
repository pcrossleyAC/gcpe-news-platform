import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createFakeMediaHub } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stands in for the stack's real `requireBearer(...) + requireRole("MediaHub.ContactsRead")` --
 * a plain header check, independent of @gcpe/auth, per this package's own "no stack
 * dependency" rule. */
const requireServiceAuth: RequestHandler = (req, res, next) => {
  const header = req.header("authorization");
  if (!header) return void res.status(401).json({ error: "missing bearer token" });
  if (header !== "Bearer has-role") return void res.status(403).json({ error: "forbidden" });
  next();
};

function setup(opts: Partial<Parameters<typeof createFakeMediaHub>[0]> = {}) {
  const fake = createFakeMediaHub({ requireServiceAuth, seed: 7, contactCount: 20, ...opts });
  const app = express();
  app.use(fake.router);
  return { app, ...fake };
}

describe("fake Media Hub", () => {
  it("401s a service call without a token, 403s with a token lacking the role", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/service/contacts")).status).toBe(401);
    expect((await request(app).get("/api/service/contacts").set("authorization", "Bearer wrong-role")).status).toBe(403);
    expect((await request(app).get("/api/service/contacts").set("authorization", "Bearer has-role")).status).toBe(200);
  });

  it("401s every service route when no requireServiceAuth was configured at all", async () => {
    const fake = createFakeMediaHub({ seed: 1, contactCount: 5 });
    const app = express();
    app.use(fake.router);
    expect((await request(app).get("/api/service/contacts").set("authorization", "Bearer anything")).status).toBe(401);
  });

  it("searches by part of a name and by outlet", async () => {
    const { app, controls } = setup();
    const live = controls.contacts().filter((c) => !c.deletedAt);
    const sample = live[0]!;
    const namePart = sample.firstName.slice(0, 3).toLowerCase();
    const byName = await request(app).get("/api/service/contacts").query({ q: namePart }).set("authorization", "Bearer has-role");
    expect(byName.status).toBe(200);
    expect(byName.body.contacts.some((c: { id: number }) => c.id === sample.id)).toBe(true);

    const outletSample = live.find((c) => c.outlet)!;
    const outletPart = outletSample.outlet!.slice(0, 4).toLowerCase();
    const byOutlet = await request(app).get("/api/service/contacts").query({ q: outletPart }).set("authorization", "Bearer has-role");
    expect(byOutlet.body.contacts.some((c: { id: number }) => c.id === outletSample.id)).toBe(true);
  });

  it("paginates with correct totals", async () => {
    const { app } = setup({ contactCount: 23 });
    const page1 = await request(app).get("/api/service/contacts").query({ page: 1, pageSize: 10 }).set("authorization", "Bearer has-role");
    expect(page1.body).toMatchObject({ page: 1, pageSize: 10 });
    expect(page1.body.contacts).toHaveLength(10);
    const total = page1.body.total as number;
    expect(total).toBeGreaterThan(0);

    const page3 = await request(app).get("/api/service/contacts").query({ page: 3, pageSize: 10 }).set("authorization", "Bearer has-role");
    expect(page3.body.total).toBe(total);
    expect(page3.body.contacts).toHaveLength(Math.max(0, total - 20));
  });

  it("get returns a deleted contact with deletedAt, and 404s an unknown id", async () => {
    const { app, controls } = setup();
    const deleted = controls.contacts().find((c) => c.deletedAt);
    expect(deleted).toBeTruthy();

    const res = await request(app).get(`/api/service/contacts/${deleted!.id}`).set("authorization", "Bearer has-role");
    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBe(deleted!.deletedAt);

    const missing = await request(app).get("/api/service/contacts/999999").set("authorization", "Bearer has-role");
    expect(missing.status).toBe(404);
  });

  it("a deleted contact never appears in search", async () => {
    const { app, controls } = setup();
    const deleted = controls.contacts().find((c) => c.deletedAt)!;
    const res = await request(app)
      .get("/api/service/contacts")
      .query({ q: deleted.firstName.toLowerCase(), pageSize: 100 })
      .set("authorization", "Bearer has-role");
    expect(res.body.contacts.some((c: { id: number }) => c.id === deleted.id)).toBe(false);
  });

  it("changes after an email change returns that contact once, then nothing", async () => {
    const { app, controls } = setup();
    const target = controls.contacts().filter((c) => !c.deletedAt)[0]!;

    const before = new Date();
    await sleep(10);
    controls.changeEmail(target.id, target.emails[0]!.ref, "changed@example.test");

    const first = await request(app)
      .get("/api/service/contacts/changes")
      .query({ since: before.toISOString() })
      .set("authorization", "Bearer has-role");
    expect(first.status).toBe(200);
    expect(first.body.contacts.map((c: { id: number }) => c.id)).toContain(target.id);
    expect(first.body.nextCursor).toBeNull();

    await sleep(10);
    const after = new Date();
    const second = await request(app)
      .get("/api/service/contacts/changes")
      .query({ since: after.toISOString() })
      .set("authorization", "Bearer has-role");
    expect(second.body.contacts).toEqual([]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("changes requires since, and rejects a garbled cursor", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/service/contacts/changes").set("authorization", "Bearer has-role")).status).toBe(400);
    const bad = await request(app)
      .get("/api/service/contacts/changes")
      .query({ since: new Date(0).toISOString(), cursor: "not-base64url-json" })
      .set("authorization", "Bearer has-role");
    expect(bad.status).toBe(400);
  });

  it("control routes work over HTTP with no auth of their own (the mounting app gates them)", async () => {
    const { app, controls } = setup({ contactCount: 10 });
    const target = controls.contacts().find((c) => !c.deletedAt)!;
    const res = await request(app).post(`/__fake/contacts/${target.id}/email`).send({ ref: target.emails[0]!.ref, address: "http-changed@example.test" });
    expect(res.status).toBe(200);
    expect(controls.contacts().find((c) => c.id === target.id)!.emails[0]!.address).toBe("http-changed@example.test");

    const removed = await request(app).post(`/__fake/contacts/${target.id}/remove-email`).send({ ref: target.emails[0]!.ref });
    expect(removed.status).toBe(200);
    expect(controls.contacts().find((c) => c.id === target.id)!.emails.some((e) => e.ref === target.emails[0]!.ref)).toBe(false);

    const deleted = await request(app).post(`/__fake/contacts/${target.id}/delete`).send({});
    expect(deleted.status).toBe(200);
    expect(controls.contacts().find((c) => c.id === target.id)!.deletedAt).not.toBeNull();

    const reset = await request(app).post("/__fake/reset").send({});
    expect(reset.status).toBe(200);
    expect(controls.contacts()).toHaveLength(10);
    expect(controls.contacts().find((c) => c.id === target.id)!.deletedAt).toBeNull();
  });

  it("the controls object reports false for an unknown contact or ref", () => {
    const { controls } = setup({ contactCount: 5 });
    const [c] = controls.contacts();
    expect(controls.changeEmail(999999, "personal", "x@example.test")).toBe(false);
    expect(controls.removeEmail(c!.id, "no-such-ref")).toBe(false);
    expect(controls.deleteContact(999999)).toBe(false);
  });

  it("persists contacts to statePath across a fresh factory call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-hub-fake-"));
    const statePath = join(dir, "state.json");
    try {
      const first = createFakeMediaHub({ requireServiceAuth, seed: 3, contactCount: 5, statePath });
      const target = first.controls.contacts()[0]!;
      first.controls.changeEmail(target.id, target.emails[0]!.ref, "persisted@example.test");

      const second = createFakeMediaHub({ requireServiceAuth, seed: 3, contactCount: 5, statePath });
      expect(second.controls.contacts().find((c) => c.id === target.id)!.emails[0]!.address).toBe("persisted@example.test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
