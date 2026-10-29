import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(classifyFilePath(`/${SITE_FILE}`)).toEqual({ kind: "public", key: SITE_FILE });
    expect(classifyFilePath(`/${SLIDE}`)).toEqual({ kind: "public", key: SLIDE });
    expect(classifyFilePath(`/slides/${"b".repeat(64)}.jpg`)).toEqual({ kind: "public", key: `slides/${"b".repeat(64)}.jpg` });
  });

  it("sends every other multi-segment path to the release lookup, decoded exactly as express.static decodes it", () => {
    expect(classifyFilePath(`/${LIVE}`)).toEqual({ kind: "lookup", key: LIVE });
    expect(classifyFilePath(`/releases%2F${UUID}%2Ftranslations%2F0123456789abcdef-budget-fr.pdf`)).toEqual({ kind: "lookup", key: LIVE });
    // Not canonical keys: these reach the lookup and are simply not found there.
    expect(classifyFilePath(`/Releases/${UUID}/x.pdf`)).toEqual({ kind: "lookup", key: `Releases/${UUID}/x.pdf` });
    expect(classifyFilePath(`/slides/${"A".repeat(64)}.png`)).toEqual({ kind: "lookup", key: `slides/${"A".repeat(64)}.png` });
  });

  it("refuses any segment that starts with a dot (the store's .meta folder, dot segments)", () => {
    for (const p of ["/.meta", `/.meta/${LIVE}.json`, "/.hidden.pdf", `/releases/${UUID}/../x.pdf`, `/slides/.${"a".repeat(64)}.png`]) expect(classifyFilePath(p), p).toEqual({ kind: "deny" });
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

  it("dot paths, Range requests and non-regular public files all get the same whole-page 404", async () => {
    const unknown = shape(await request(app).get(`/files/releases/${UUID}/translations/0000000000000000-nope.pdf`));
    await mkdir(join(storageDir, "a-directory"), { recursive: true });
    await symlink(join(storageDir, SITE_FILE), join(storageDir, "linked.pdf"));
    await mkdir(join(storageDir, "slides", `${"c".repeat(64)}.png`), { recursive: true });
    await symlink(join(storageDir, SLIDE), join(storageDir, "slides", `${"d".repeat(64)}.png`));
    for (const p of ["/files/.meta", `/files/.meta/${LIVE}.json`, "/files/a-directory", "/files/linked.pdf", `/files/slides/${"c".repeat(64)}.png`, `/files/slides/${"d".repeat(64)}.png`]) {
      expect(shape(await request(app).get(p)), p).toEqual(unknown);
    }
    const ranged = await request(app).get(`/files/${DRAFT}`).set("range", "bytes=0-3");
    expect(shape(ranged)).toEqual(unknown);
    expect(ranged.headers["content-range"]).toBeUndefined();
    expect(unknown.etag).toBeUndefined();
    expect(unknown.lastModified).toBeUndefined();
    // A real file is still served (and still honours ranges, as express.static always has).
    expect((await request(app).get(`/files/${SITE_FILE}`)).status).toBe(200);
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

// Legacy news.gov.bc.ca/files/<name>: the legacy Hub's uploads, imported as NRMS site files
// (apps/stack/src/legacy-files). A name that isn't its own storage key is found through
// siteFileByName (case-insensitive); nothing found is 302'd to the Azure origin when that is on.
describe("filesHandlers with imported legacy site files", () => {
  const ORIGIN = "https://legacy-origin.example";
  let storageDir: string;
  let outputDir: string;
  const isPublic = vi.fn(async (key: string) => key === LIVE);
  /** name (any case) → storage key, as NRMS's findSiteFileByName answers. */
  const rows = new Map<string, { name: string; storageKey: string }>();
  const siteFileByName = vi.fn(async (name: string) => rows.get(name.toLowerCase()) ?? null);
  const appWith = (fallbackOrigin: string | null) => {
    const a = express();
    a.use("/files", ...filesHandlers({ storageDir, outputDir, isPublic: (k) => isPublic(k), siteFileByName: (n) => siteFileByName(n), fallbackOrigin }));
    a.use((_req, res) => void res.status(404).json({ error: "not found" }));
    return a;
  };
  let on: express.Express;
  let off: express.Express;
  const imported = async (name: string, storageKey: string, body: string | Buffer) => {
    await writeFile(join(storageDir, storageKey), body);
    rows.set(name.toLowerCase(), { name, storageKey });
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "gcpe-files-legacy-storage-"));
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-files-legacy-site-"));
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    const store = localStore(storageDir);
    await store.put(LIVE, Buffer.from("%PDF-1.7 live"), "application/pdf");
    await store.put(DRAFT, PNG, "image/png");
    await store.put(SITE_FILE, Buffer.from("%PDF-1.7 nrms site file"), "application/pdf");
    await imported("News_Footage_License_British_Columbia.pdf", "news_footage_license_british_columbia.pdf", "%PDF legacy licence");
    await imported("Q1_ MediaDeck.pdf", "legacy-0a1b2c3d-q1_-mediadeck.pdf", "%PDF deck");
    // A site file row pointing at a release-shaped key must never be served through the name lookup.
    rows.set("sneaky.pdf", { name: "sneaky.pdf", storageKey: DRAFT });
    on = appWith(ORIGIN);
    off = appWith(null);
  });
  afterAll(async () => {
    for (const d of [storageDir, outputDir]) await rm(d, { recursive: true, force: true });
  });

  const notFoundShape = { status: 404, body: "<h1>Page not found</h1>", cache: "no-store" };
  const brief = (res: request.Response) => ({ status: res.status, body: res.text, cache: res.headers["cache-control"] });

  it("serves an imported legacy file by its legacy name, in any letter case (legacy parity), with the 60 s public cache and nosniff; inline PDFs get no sandbox CSP (Firefox/Safari PDF viewers)", async () => {
    for (const p of ["/files/News_Footage_License_British_Columbia.pdf", "/files/news_footage_license_british_columbia.pdf", "/files/NEWS_FOOTAGE_LICENSE_BRITISH_COLUMBIA.PDF", "/files/Q1_%20MediaDeck.pdf", "/files/q1_%20mediadeck.PDF"]) {
      const res = await request(off).get(p);
      expect(res.status, p).toBe(200);
      expect(res.headers["content-type"], p).toBe("application/pdf");
      expect(res.headers["cache-control"], p).toBe("public, max-age=60");
      expect(res.headers["x-content-type-options"], p).toBe("nosniff");
      expect(res.headers["content-security-policy"], p).toBeUndefined();
    }
    expect((await request(off).get("/files/Q1_%20MediaDeck.pdf")).body.toString()).toBe("%PDF deck");
    expect((await request(off).head("/files/Q1_%20MediaDeck.pdf")).status).toBe(200);
  });

  it("an NRMS file at the key itself is served without a name lookup, as before", async () => {
    siteFileByName.mockClear();
    expect((await request(on).get(`/files/${SITE_FILE}`)).body.toString()).toBe("%PDF-1.7 nrms site file");
    expect(siteFileByName).not.toHaveBeenCalled();
  });

  it("Q17: a non-live release key stays the plain 404 (never a lookup, never the 302), in any case; the name lookup never serves a multi-segment key", async () => {
    for (const app of [on, off]) {
      for (const p of [`/files/${DRAFT}`, `/files/releases/${UUID}/translations/0000000000000000-nope.pdf`, `/files/Releases/${UUID}/assets/fedcba9876543210-photo.png`, `/files/RELEASES/x.pdf`, `/files/slides/${"e".repeat(64)}.png`, "/files/Slides/x.png"]) {
        expect(brief(await request(app).get(p)), p).toEqual(notFoundShape);
      }
    }
    expect(brief(await request(off).get("/files/sneaky.pdf"))).toEqual(notFoundShape);
    expect((await request(on).get("/files/sneaky.pdf")).status).toBe(302);
  });

  it("dot paths and Windows aliases are the 404, never a lookup hit or a 302", async () => {
    for (const p of ["/files/.meta", "/files/NEWS_F~1.PDF", "/files/News_Footage_License_British_Columbia.pdf.", "/files/a%5Cb.pdf", "/files/Newsroom/../x.pdf", "/files/Newsroom/%2e%2e/x.pdf", "/files//x.pdf", "/files/folder/"]) {
      expect(brief(await request(on).get(p)), p).toEqual(notFoundShape);
    }
  });

  it("the safety net: an unknown path is a 302 (no-store) to the configured origin, lowercased as legacy stored it, segments encoded; off: the 404", async () => {
    const res = await request(on).get("/files/Newsroom/Not%20Copied%23yet.pdf?x=1");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/files/newsroom/not%20copied%23yet.pdf`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await request(on).get("/files/Unknown.pdf")).headers.location).toBe(`${ORIGIN}/files/unknown.pdf`);
    expect((await request(on).head("/files/unknown.pdf")).status).toBe(302);
    expect(brief(await request(off).get("/files/Newsroom/Not%20Copied%23yet.pdf"))).toEqual(notFoundShape);
  });

  it("an NRMS single-segment name that exists but isn't a regular file is NRMS's 404, not a lookup or a fallback", async () => {
    await mkdir(join(storageDir, "nrms-dir"), { recursive: true });
    expect(brief(await request(on).get("/files/nrms-dir"))).toEqual(notFoundShape);
  });

  it("a failed name lookup is a 503 that is never cached, never a 302", async () => {
    siteFileByName.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(on).get("/files/Anything.pdf");
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    spy.mockRestore();
  });

  it("security: only inert types are served inline; anything that could run (.html, .svg, .xml, .js, unknown, none) is an octet-stream attachment with the sandbox CSP; inline types get no CSP; nosniff on every answer", async () => {
    const CSP = "sandbox; default-src 'none'";
    const files: [string, string][] = [
      ["Page.html", "<script>alert(1)</script>"],
      ["pic.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ["feed.xml", "<x/>"],
      ["thing.weird", "?"],
      ["script.js", "alert(1)"],
      ["noext", "?"],
      ["notes.txt", "hello"],
      ["data.csv", "a,b"],
      ["deck.pptx", "pk"],
    ];
    for (const [name, body] of files) await imported(name, `k-${name.toLowerCase()}`, body);
    for (const name of ["Page.html", "pic.svg", "feed.xml", "thing.weird", "script.js", "noext"]) {
      const res = await request(off).get(`/files/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers["content-type"], name).toBe("application/octet-stream");
      expect(res.headers["content-disposition"], name).toMatch(/^attachment; filename="/);
      expect(res.headers["content-security-policy"], name).toBe(CSP);
      expect(res.headers["x-content-type-options"], name).toBe("nosniff");
    }
    // Served straight from its key (the static path) gets the same policy.
    await writeFile(join(storageDir, "direct.html"), "<script>alert(1)</script>");
    const direct = await request(off).get("/files/direct.html");
    expect(direct.headers["content-type"]).toBe("application/octet-stream");
    expect(direct.headers["content-disposition"]).toMatch(/^attachment/);
    expect(direct.headers["content-security-policy"]).toBe(CSP);
    const pdf = await request(off).get("/files/News_Footage_License_British_Columbia.pdf");
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBeUndefined();
    expect(pdf.headers["content-security-policy"]).toBeUndefined();
    expect(pdf.headers["x-content-type-options"]).toBe("nosniff");
    const live = await request(off).get(`/files/${LIVE}`);
    expect(live.headers["content-type"]).toBe("application/pdf");
    expect(live.headers["content-security-policy"]).toBeUndefined();
    expect((await request(off).get("/files/notes.txt")).headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect((await request(off).get("/files/data.csv")).headers["content-type"]).toBe("text/plain; charset=utf-8");
    const pptx = await request(off).get("/files/deck.pptx");
    expect(pptx.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(pptx.headers["content-disposition"]).toBeUndefined();
    expect(pptx.headers["content-security-policy"]).toBeUndefined();
    const head = await request(off).head("/files/Page.html");
    expect(head.headers["content-type"]).toBe("application/octet-stream");
    expect(head.headers["content-disposition"]).toMatch(/^attachment/);
    expect(head.headers["content-security-policy"]).toBe(CSP);
  });

  it("a write method is still refused (405)", async () => {
    expect((await request(on).post("/files/News_Footage_License_British_Columbia.pdf")).status).toBe(405);
  });
});
