import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type express from "express";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { activityFiles } from "../db/schema";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, seedWorld, validInput, type World, type Who } from "../../test/world";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");

describe("attachment downloads: visibility decides, not the file id (spec addendum §6, §8.4; C138)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: express.Express;
  let dir: string;
  let store: ObjectStore;
  const upload = async (who: Who, id: number, name: string) =>
    (
      await request(app)
        .post(`/api/activities/${id}/files`)
        .set("cookie", w.as[who].cookie)
        .set("x-gcpe-request", "1")
        .set("x-gcpe-file-name", encodeURIComponent(name))
        .set("content-type", "application/pdf")
        .send(PDF)
    ).body as { id: number; fileName: string }[];
  const download = (who: Who, id: number | string, fileId: number | string) =>
    request(app)
      .get(`/api/activities/${id}/files/${fileId}`)
      .set("cookie", w.as[who].cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
  const createAs = async (who: Who, over = {}) => (await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over))).body.id as number;
  const fileOn = async (id: number, name = "Sample report.pdf") => (await upload("hqAdmin", id, name)).find((f) => f.fileName === name)!.id;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "calendar-files-"));
    store = localStore(dir);
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { store });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("another ministry's confidential file is a 404; its own ministry, a shared ministry and HQ Advanced and above get it", async () => {
    const b = await createAs("editor", { isConfidential: true });
    const fb = await fileOn(b);
    const e = await createAs("financeEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor, isConfidential: true, sharedWithKeys: ["health"] });
    const fe = await fileOn(e);
    const cases: [Who, number, number, number][] = [
      ["readOnly", b, fb, 200], ["editor", b, fb, 200], ["financeEditor", b, fb, 404],
      ["hqReadOnly", b, fb, 404], ["hqEditor", b, fb, 404], ["hqAdvanced", b, fb, 200], ["hqAdmin", b, fb, 200],
      ["financeEditor", e, fe, 200], ["editor", e, fe, 200], ["hqEditor", e, fe, 404],
    ];
    for (const [who, id, fileId, status] of cases) expect((await download(who, id, fileId)).status, `${who} on ${id}`).toBe(status);
  });

  it("serves it as an attachment with a safe name, nosniff, no caching and a sandbox", async () => {
    const id = await createAs("editor");
    const fileId = await fileOn(id, 'Résumé "final".pdf');
    const res = await download("editor", id, fileId);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    const cd = res.headers["content-disposition"] as string;
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf");
    expect(cd).not.toMatch(/[\r\n]/);
    expect((res.body as Buffer).equals(PDF)).toBe(true);
  });

  it("an imported file of a type outside the list downloads as a plain file, never as a page", async () => {
    const id = await createAs("editor");
    const key = `activities/${id}/0000000000000000-imported.html`;
    await store.put(key, Buffer.from("<html><script>alert(1)</script></html>"), "text/html");
    const [row] = await tdb.db.insert(activityFiles).values({ activityId: id, fileName: "imported.html", contentType: "text/html", length: 38, sha256: "0".repeat(64), storageKey: key }).returning();
    const res = await download("editor", id, row!.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("an HTML file saved as .txt downloads as text/plain, nosniff, as an attachment, never rendered", async () => {
    const id = await createAs("editor");
    const key = `activities/${id}/0000000000000000-notes.txt`;
    await store.put(key, Buffer.from("<html><script>alert(1)</script></html>"), "text/plain");
    const [row] = await tdb.db.insert(activityFiles).values({ activityId: id, fileName: "notes.txt", contentType: "text/plain", length: 38, sha256: "0".repeat(64), storageKey: key }).returning();
    const res = await download("editor", id, row!.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("a link kept after the activity became confidential, or was deleted, is a 404 for whoever can no longer see it", async () => {
    const id = await createAs("editor");
    const fileId = await fileOn(id);
    expect((await download("hqEditor", id, fileId)).status).toBe(200);
    const v = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await call(app, "put", `/api/activities/${id}`, w.as.editor.cookie, { ...v.fields, isConfidential: true, version: v.version, tabId: null })).status).toBe(200);
    expect((await download("hqEditor", id, fileId)).status).toBe(404);
    expect((await download("readOnly", id, fileId)).status).toBe(200);
    const v2 = (await call(app, "get", `/api/activities/${id}`, w.as.admin.cookie)).body;
    await call(app, "delete", `/api/activities/${id}`, w.as.admin.cookie, { version: v2.version });
    expect((await download("editor", id, fileId)).status).toBe(404);
    expect((await download("hqAdmin", id, fileId)).status).toBe(200);
  });

  it("a file id from another activity, a malformed id and a missing stored file are all 404", async () => {
    const a = await createAs("editor");
    const b = await createAs("editor");
    const fa = await fileOn(a);
    expect((await download("editor", b, fa)).status).toBe(404);
    expect((await download("editor", a, "1e3")).status).toBe(404);
    expect((await download("editor", "abc", fa)).status).toBe(404);
    const [row] = await tdb.db.select().from(activityFiles).where(eq(activityFiles.id, fa));
    await store.delete(row!.storageKey);
    expect((await download("editor", a, fa)).status).toBe(404);
  });
});
