import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type express from "express";
import { ATTACHMENT_MAX_BYTES } from "@gcpe/calendar-contract";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { activities, activityFiles } from "../db/schema";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, historyOf, seedWorld, validInput, type World, type Who } from "../../test/world";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");
/** 16:30 BC on 2026-11-03, inside the 4pm-5pm freeze (UTC−7 from 2026-11-01). */
const FROZEN = new Date("2026-11-03T23:30:00Z");

describe("attachments: upload, replace and remove (spec addendum §8.4)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: express.Express;
  let dir: string;
  let store: ObjectStore;
  const upload = (who: Who, id: number, name: string, bytes: Buffer = PDF, on: express.Express = app) =>
    request(on)
      .post(`/api/activities/${id}/files`)
      .set("cookie", w.as[who].cookie)
      .set("x-gcpe-request", "1")
      .set("x-gcpe-file-name", encodeURIComponent(name))
      .set("content-type", "application/octet-stream")
      .send(bytes);
  const remove = (who: Who, id: number, fileId: number | string) => call(app, "delete", `/api/activities/${id}/files/${fileId}`, w.as[who].cookie);
  const create = async (over = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.id as number;
  const stored = async (id: number) => (await store.list(`activities/${id}`)).map((o) => o.key);
  const names = (body: { fileName: string }[]) => body.map((f) => f.fileName);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "calendar-files-"));
    store = localStore(dir);
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { store });
    w = await seedWorld(app, tdb.db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("an editor of the lead ministry uploads a PDF: listed, stored under a flat key, history written, nothing else changed", async () => {
    const id = await create();
    const [before] = await tdb.db.select().from(activities).where(eq(activities.id, id));
    const res = await upload("editor", id, "Sample briefing.pdf");
    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({ fileName: "Sample briefing.pdf", contentType: "application/pdf", length: PDF.length, uploadedByName: "Robin Staff" })]);
    const [row] = await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id));
    expect(row!.storageKey).toMatch(new RegExp(`^activities/${id}/[0-9a-f]{16}-sample-briefing\\.pdf$`));
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await stored(id)).toEqual([row!.storageKey]);
    const [after] = await tdb.db.select().from(activities).where(eq(activities.id, id));
    expect(after).toMatchObject({ version: before!.version, status: before!.status, needsReview: before!.needsReview, lastUpdatedAt: before!.lastUpdatedAt });
    expect((await historyOf(tdb.db, id)).at(-1)).toEqual({ action: "updated", actorName: "Robin Staff", fields: { files: [null, "Sample briefing.pdf"] } });
  });

  it("a file with the same name, in any case, replaces the old one and deletes its bytes (Activity.aspx.cs:1436-1437)", async () => {
    const id = await create();
    await upload("editor", id, "Sample.pdf");
    const first = await stored(id);
    const res = await upload("admin", id, "SAMPLE.PDF", Buffer.concat([PDF, Buffer.from("more")]));
    expect(res.status).toBe(201);
    expect(names(res.body)).toEqual(["SAMPLE.PDF"]);
    const now = await stored(id);
    expect(now).toHaveLength(1);
    expect(now).not.toEqual(first);
    expect((await historyOf(tdb.db, id)).at(-1)!.fields).toEqual({ files: ["Sample.pdf", "SAMPLE.PDF (replaced)"] });
  });

  it.each([
    ["an empty file", "Sample.pdf", Buffer.alloc(0), "The file is empty."],
    ["a blocked extension", "Sample.exe", Buffer.from("MZ"), "This type of file can't be attached."],
    ["a type outside the list", "Sample.html", Buffer.from("<html></html>"), "Attach a PDF, image (PNG, JPEG or GIF), Word, Excel, PowerPoint, Outlook message, RTF, text or CSV file."],
    ["contents that don't match the name", "Sample.pdf", Buffer.from("<html><script></script></html>"), "The file's contents aren't a .pdf file."],
    ["a name with no file in it", "..\\", PDF, "Name the file."],
  ])("refuses %s with 422 and stores nothing", async (_what, name, bytes, message) => {
    const id = await create();
    const res = await upload("editor", id, name, bytes);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: "files", message }]);
    expect(await stored(id)).toEqual([]);
  });

  it("keeps only the file's own name: path segments and control characters go, and the length is capped keeping the extension", async () => {
    const id = await create();
    expect(names((await upload("editor", id, "..\\..\\Sample report.pdf")).body)).toEqual(["Sample report.pdf"]);
    expect(names((await upload("editor", id, "a/b/c\r\nd.pdf")).body)).toContain("c d.pdf");
    expect(names((await upload("editor", id, `${"x".repeat(400)}.pdf`)).body)).toContain(`${"x".repeat(251)}.pdf`);
    for (const k of await stored(id)) expect(k).toMatch(/^activities\/\d+\/[0-9a-f]{16}-[a-z0-9._-]+$/);
  });

  it("strips bidi and other invisible format characters, not just C0 controls, from the display name", async () => {
    const id = await create();
    expect(names((await upload("editor", id, "‮gnp.pdf")).body)).toEqual(["gnp.pdf"]);
  });

  it("refuses a missing, empty or undecodable X-GCPE-File-Name header with 400, following the existing error shape; the name never travels in the query string", async () => {
    const id = await create();
    const base = () => request(app).post(`/api/activities/${id}/files`).set("cookie", w.as.editor.cookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream");
    const missing = await base().send(PDF);
    const empty = await base().set("x-gcpe-file-name", "").send(PDF);
    const undecodable = await base().set("x-gcpe-file-name", "%").send(PDF);
    for (const res of [missing, empty, undecodable]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid request", issues: [expect.objectContaining({ path: ["name"] })] });
    }
    expect(await stored(id)).toEqual([]);
    // a name that used to travel as ?name= is rejected: the route no longer reads the query string at all.
    const viaQuery = await base().set("x-gcpe-file-name", "").query({ name: "Sample.pdf" }).send(PDF);
    expect(viaQuery.status).toBe(400);
  });

  it("is refused before the body is read: invisible 404 (even over 25 MB), view-only 403, deleted 409, someone else's lock 423, the freeze 423", async () => {
    const secret = await create({ isConfidential: true });
    expect((await upload("financeEditor", secret, "Sample.pdf", Buffer.alloc(26 * 1024 * 1024, 0x25))).status).toBe(404);
    const shared = await create({ sharedWithKeys: ["finance"] });
    expect((await upload("financeEditor", shared, "Sample.pdf")).status).toBe(403);
    const gone = await create();
    const version = (await call(app, "get", `/api/activities/${gone}`, w.as.admin.cookie)).body.version;
    await call(app, "delete", `/api/activities/${gone}`, w.as.admin.cookie, { version });
    const deleted = await upload("hqAdmin", gone, "Sample.pdf");
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("deleted");
    const locked = await create();
    await call(app, "put", `/api/activities/${locked}/lock`, w.as.admin.cookie, { tabId: "tab-a" });
    const l = await upload("editor", locked, "Sample.pdf");
    expect(l.status).toBe(423);
    expect(l.body).toMatchObject({ code: "locked", holder: { displayName: "Sample Admin" } });
    const frozen = createTestApp(tdb.db, { store, now: () => FROZEN });
    const f = await upload("editor", await create(), "Sample.pdf", PDF, frozen);
    expect(f.status).toBe(423);
    expect(f.body.code).toBe("freeze");
    expect((await upload("hqEditor", await create(), "Sample.pdf", PDF, frozen)).status).toBe(201);
  });

  it("a file over 25 MB is 413, and nothing is stored", async () => {
    const id = await create();
    const res = await upload("editor", id, "Sample.pdf", Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]));
    expect(res.status).toBe(413);
    expect(await stored(id)).toEqual([]);
  });

  it("a declared Content-Length over the limit is 413 before any body is read, and closes the connection", async () => {
    const id = await create();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1", port, method: "POST", path: `/api/activities/${id}/files`,
            headers: {
              cookie: w.as.editor.cookie, "x-gcpe-request": "1", "content-type": "application/octet-stream",
              "x-gcpe-file-name": encodeURIComponent("Sample.pdf"), "content-length": String(ATTACHMENT_MAX_BYTES + 1),
            },
          },
          (r) => {
            r.resume();
            r.on("end", () => resolve({ status: r.statusCode!, connection: r.headers.connection }));
          },
        );
        req.on("error", reject);
        // No body is ever written: the server must answer without waiting for one.
        req.end();
      });
      expect(res.status).toBe(413);
      expect(res.connection).toBe("close");
    } finally {
      server.close();
    }
    expect(await stored(id)).toEqual([]);
  });

  it("a chunked upload (no declared Content-Length) over 25 MB gets the same message as a declared-size refusal", async () => {
    const id = await create();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1", port, method: "POST", path: `/api/activities/${id}/files`,
            headers: {
              cookie: w.as.editor.cookie, "x-gcpe-request": "1", "content-type": "application/octet-stream",
              "x-gcpe-file-name": encodeURIComponent("Sample.pdf"),
              // No content-length: Node's http module streams this as chunked transfer-encoding,
              // the one path `declaredSize`'s pre-check can't refuse (it relies on the header).
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.write(Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]));
        req.end();
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: "A file can be at most 25 MB." });
    } finally {
      server.close();
    }
    expect(await stored(id)).toEqual([]);
  });

  it("holds at most 50 files; the refused upload leaves no bytes behind, and replacing still works", async () => {
    const id = await create();
    await tdb.db.insert(activityFiles).values(
      Array.from({ length: 50 }, (_, i) => ({
        activityId: id, fileName: `sample-${i}.pdf`, contentType: "application/pdf", length: 1, sha256: "0".repeat(64),
        storageKey: `activities/${id}/${String(i).padStart(16, "0")}-sample-${i}.pdf`,
      })),
    );
    const res = await upload("editor", id, "One more.pdf");
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: "files", message: "An activity holds at most 50 files. Remove one first." }]);
    expect(await stored(id)).toEqual([]);
    expect((await upload("editor", id, "SAMPLE-3.pdf")).status).toBe(201);
  });

  it("two uploads of different names racing at 49 files leave one 201, one 422, 50 rows and one new stored object", async () => {
    const id = await create();
    await tdb.db.insert(activityFiles).values(
      Array.from({ length: 49 }, (_, i) => ({
        activityId: id, fileName: `sample-${i}.pdf`, contentType: "application/pdf", length: 1, sha256: "0".repeat(64),
        storageKey: `activities/${id}/${String(i).padStart(16, "0")}-sample-${i}.pdf`,
      })),
    );
    const before = await stored(id);
    const [a, b] = await Promise.all([upload("editor", id, "Race A.pdf"), upload("admin", id, "Race B.pdf")]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id))).toHaveLength(50);
    const after = await stored(id);
    expect(after).toHaveLength(before.length + 1);
  });

  it("the bytes are deleted when the database write fails after they were stored", async () => {
    const id = await create();
    await tdb.pool.query("CREATE OR REPLACE FUNCTION probe_fail_activity_files() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql");
    await tdb.pool.query("CREATE TRIGGER probe_fail_activity_files BEFORE INSERT ON activity_files FOR EACH ROW EXECUTE FUNCTION probe_fail_activity_files()");
    try {
      const res = await upload("editor", id, "Sample.pdf");
      expect(res.status).toBe(500);
    } finally {
      await tdb.pool.query("DROP TRIGGER probe_fail_activity_files ON activity_files");
    }
    expect(await stored(id)).toEqual([]);
    expect(await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id))).toEqual([]);
  });

  it("a store whose put writes the bytes and then throws leaves nothing behind", async () => {
    const id = await create();
    const faulty: ObjectStore = {
      ...store,
      async put(key, bytes, contentType) {
        await store.put(key, bytes, contentType);
        throw Object.assign(new Error("ENOSPC simulated"), { code: "ENOSPC" });
      },
    };
    const faultyApp = createTestApp(tdb.db, { store: faulty });
    const res = await upload("editor", id, "Sample.pdf", PDF, faultyApp);
    expect(res.status).toBe(500);
    expect(await stored(id)).toEqual([]);
    expect(await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id))).toEqual([]);
  });

  it("a failed post-commit delete logs only the activity id and the file row id, never a name or a storage key", async () => {
    const id = await create();
    const [before] = (await upload("editor", id, "Sample.pdf")).body;
    const [beforeRow] = await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id));
    const oldKey = beforeRow!.storageKey;
    const faulty: ObjectStore = {
      ...store,
      async delete() {
        throw Object.assign(new Error("EIO simulated"), { code: "EIO" });
      },
    };
    const faultyApp = createTestApp(tdb.db, { store: faulty });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload("editor", id, "SAMPLE.PDF", PDF, faultyApp);
    expect(res.status).toBe(201);
    const lines = errorSpy.mock.calls.map((args) => args.map((a) => String(a)).join(" "));
    const relevant = lines.filter((l) => l.includes("could not delete a stored file"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toContain(String(id));
    expect(relevant[0]).toContain(String(before.id));
    expect(relevant[0]).not.toContain("Sample.pdf");
    expect(relevant[0]).not.toContain(oldKey);
  });

  it("removes a file: its row and bytes go and history says so; another activity's file id, or a non-number, is 404", async () => {
    const id = await create();
    const other = await create();
    const [f] = (await upload("editor", id, "Sample.pdf")).body;
    const [g] = (await upload("editor", other, "Other.pdf")).body;
    expect((await remove("editor", id, g.id)).status).toBe(404);
    expect((await remove("editor", id, "abc")).status).toBe(404);
    expect((await remove("readOnly", other, g.id)).status).toBe(403);
    const res = await remove("editor", id, f.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(await stored(id)).toEqual([]);
    expect((await historyOf(tdb.db, id)).at(-1)!.fields).toEqual({ files: ["Sample.pdf", null] });
  });

  it("two uploads of one name at once leave one row and one stored file", async () => {
    const id = await create();
    const [a, b] = await Promise.all([upload("editor", id, "Same.pdf"), upload("editor", id, "same.pdf")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id))).toHaveLength(1);
    expect(await stored(id)).toHaveLength(1);
  });

  it("answers 503 when no storage is configured", async () => {
    expect((await upload("editor", await create(), "Sample.pdf", PDF, createTestApp(tdb.db))).status).toBe(503);
  });
});
