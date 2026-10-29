import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { localStore } from "@gcpe/storage";
import { classifyFilePath, FILES_MAX_AGE_MS, filesHandlers } from "./files-gate";

// Q17 (owner decision 2026-10-28): a release's files are public only while the release is live.
// The release rule itself (live, not unpublishing) is NRMS's isReleaseFilePublic and is tested
// there (apps/nrms/src/media/files.test.ts); here it is a stub over a set of "live" keys.

const UUID = "00000000-0000-4000-8000-000000000001";
const LIVE = `releases/${UUID}/translations/0123456789abcdef-budget-fr.pdf`;
const DRAFT = `releases/${UUID}/assets/fedcba9876543210-photo.png`;
const SLIDE = `slides/${"a".repeat(64)}.png`;
const SITE_FILE = "news-footage-licence.pdf";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

describe("classifyFilePath", () => {
  it("passes single-segment site files and content-addressed slide images straight to the static mount", () => {
    expect(classifyFilePath(`/${SITE_FILE}`)).toEqual({ kind: "public" });
    expect(classifyFilePath(`/${SLIDE}`)).toEqual({ kind: "public" });
    expect(classifyFilePath(`/slides/${"b".repeat(64)}.jpg`)).toEqual({ kind: "public" });
  });

  it("sends every other multi-segment path to the release lookup, decoded exactly as express.static decodes it", () => {
    expect(classifyFilePath(`/${LIVE}`)).toEqual({ kind: "lookup", key: LIVE });
    expect(classifyFilePath(`/releases%2F${UUID}%2Ftranslations%2F0123456789abcdef-budget-fr.pdf`)).toEqual({ kind: "lookup", key: LIVE });
    // Not canonical keys: these reach the lookup and are simply not found there.
    expect(classifyFilePath(`/Releases/${UUID}/x.pdf`)).toEqual({ kind: "lookup", key: `Releases/${UUID}/x.pdf` });
    expect(classifyFilePath(`/slides/${"A".repeat(64)}.png`)).toEqual({ kind: "lookup", key: `slides/${"A".repeat(64)}.png` });
    expect(classifyFilePath(`/.meta/${LIVE}.json`)).toEqual({ kind: "lookup", key: `.meta/${LIVE}.json` });
  });

  it("refuses malformed encodings, backslashes, colons, NULs and the bare root outright", () => {
    for (const p of ["/%E0%A4%A", `/releases%5C${UUID}%5Cx.pdf`, "/c:x.pdf", "/a%00b.pdf", "/", ""]) expect(classifyFilePath(p)).toEqual({ kind: "deny" });
  });
});

describe("filesHandlers (the stack's public /files)", () => {
  let storageDir: string;
  let outputDir: string;
  const isPublic = vi.fn(async (key: string) => key === LIVE);
  let app: express.Express;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "gcpe-files-gate-storage-"));
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-files-gate-site-"));
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    const store = localStore(storageDir);
    await store.put(LIVE, Buffer.from("%PDF-1.7 live"), "application/pdf");
    await store.put(DRAFT, PNG, "image/png");
    await store.put(SLIDE, PNG, "image/png");
    await store.put(SITE_FILE, Buffer.from("%PDF-1.7 site"), "application/pdf");
    app = express();
    app.use("/files", ...filesHandlers({ storageDir, outputDir, isPublic: (k) => isPublic(k) })); // as stack.ts mounts it
    app.use((_req, res) => void res.status(404).json({ error: "not found" })); // News API's root catch-all
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  /** Everything a client (or a cache) could tell two 404s apart by. */
  const shape = (res: request.Response) => ({
    status: res.status,
    body: res.text,
    type: res.headers["content-type"],
    cache: res.headers["cache-control"],
    length: res.headers["content-length"],
    nosniff: res.headers["x-content-type-options"],
    etag: res.headers["etag"],
    lastModified: res.headers["last-modified"],
  });

  it("a live release's file is served with the same headers as before the gate: type, public max-age=60, nosniff", async () => {
    const res = await request(app).get(`/files/${LIVE}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe("%PDF-1.7 live");
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["cache-control"]).toBe(`public, max-age=${FILES_MAX_AGE_MS / 1000}`);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(isPublic).toHaveBeenCalledWith(LIVE);
  });

  it("a release file that isn't public answers exactly the 404 an unknown key gets — the site's 404 page, never cached", async () => {
    const unknown = shape(await request(app).get(`/files/releases/${UUID}/translations/0000000000000000-nope.pdf`));
    expect(unknown).toMatchObject({ status: 404, body: "<h1>Page not found</h1>", cache: "no-store" });
    expect(shape(await request(app).get(`/files/${DRAFT}`))).toEqual(unknown);
    // Malformed, non-canonical and odd paths: the same 404.
    for (const p of [
      "/files/%E0%A4%A",
      `/files/Releases/${UUID}/assets/fedcba9876543210-photo.png`,
      `/files/releases/${UUID}/assets`,
      `/files/releases/${UUID}/assets/`,
      `/files/.meta/${DRAFT}.json`,
      `/files//${DRAFT}`,
      `/files/./${DRAFT}`,
      `/files/releases%5C${UUID}%5Cassets%5Cfedcba9876543210-photo.png`,
      "/files/missing-site-file.pdf",
      "/files/",
    ]) {
      expect(shape(await request(app).get(p)), p).toEqual(unknown);
    }
  });

  it("HEAD follows the same rule", async () => {
    expect((await request(app).head(`/files/${LIVE}`)).status).toBe(200);
    const draft = await request(app).head(`/files/${DRAFT}`);
    expect(draft.status).toBe(404);
    expect(draft.headers["cache-control"]).toBe("no-store");
  });

  it("site files and slide images are served as before, without a release lookup", async () => {
    isPublic.mockClear();
    const site = await request(app).get(`/files/${SITE_FILE}`);
    expect(site.status).toBe(200);
    expect(site.headers["cache-control"]).toBe("public, max-age=60");
    const slide = await request(app).get(`/files/${SLIDE}`);
    expect(slide.status).toBe(200);
    expect(slide.headers["content-type"]).toBe("image/png");
    expect(isPublic).not.toHaveBeenCalled();
  });

  it("a failed lookup is a 503 that is never cached, and never serves the file", async () => {
    isPublic.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get(`/files/${LIVE}`);
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toContain("PDF");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a write method is refused by the static mount (405) without a lookup, as before", async () => {
    isPublic.mockClear();
    expect((await request(app).post(`/files/${DRAFT}`)).status).toBe(405);
    expect(isPublic).not.toHaveBeenCalled();
  });
});
