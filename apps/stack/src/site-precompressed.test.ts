import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { fsStorage } from "../../public-site/src/storage";
import { noStoreByDefault } from "./cache-control";
import { textCompression } from "./compress";
import { mountSite, rootSiteNotFound } from "./site-mount";

interface Res { status: number; headers: IncomingHttpHeaders; body: Buffer }
function get(server: Server, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Res> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
const decode = (r: Res): Buffer => (r.headers["content-encoding"] === "br" ? brotliDecompressSync(r.body) : r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.headers["content-encoding"] === "deflate" ? inflateSync(r.body) : r.body);

const BODY = (label: string) => `<!doctype html><title>${label}</title>` + `<p>government news release body text ${label}</p>\n`.repeat(120);
const CSS = "body { color: #013366; }\n".repeat(300);
const FEED = `<?xml version="1.0"?><rss>${"<item><title>a news release</title></item>".repeat(60)}</rss>`;
const PNG = Buffer.alloc(6000, 9);

/** The same files in two folders: one written through the site's storage (with companions), one plain. */
async function makeSite(withCompanions: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gcpe-precompressed-"));
  const put = async (rel: string, body: string | Uint8Array) => {
    if (withCompanions) await fsStorage(dir).write(rel, body);
    else {
      await import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), body);
      });
    }
  };
  await put("index.html", BODY("home"));
  await put("releases/k/index.html", BODY("release k"));
  await put("assets/site.css", CSS);
  await put("feed.xml", FEED);
  await put("atom.xml", FEED);
  await put("404.html", BODY("site 404"));
  await put("tiny.html", "<p>tiny</p>");
  await put("photo.png", PNG);
  await put(".site-state.json", JSON.stringify({ big: "x".repeat(3000) }));
  return dir;
}

function appFor(outputDir: string, basePath: string): express.Express {
  const app = express();
  app.use(textCompression());
  mountSite(app, { outputDir, basePath });
  app.use(rootSiteNotFound(outputDir, ["/api"]));
  app.use(noStoreByDefault);
  app.use((_req, res) => void res.status(404).json({ fellThrough: true }));
  return app;
}
const listen = (app: express.Express) => new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

describe("precompressed static files", () => {
  let dir: string;
  let plainDir: string;
  let server: Server;
  let plain: Server;
  let prefixed: Server;
  beforeAll(async () => {
    dir = await makeSite(true);
    plainDir = await makeSite(false);
    server = await listen(appFor(dir, ""));
    plain = await listen(appFor(plainDir, ""));
    prefixed = await listen(appFor(dir, "/site"));
  });
  afterAll(async () => {
    await Promise.all([close(server), close(plain), close(prefixed)]);
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(plainDir, { recursive: true, force: true })]);
  });

  it("sends the stored brotli copy: encoding, type, Vary, Cache-Control, exact length, and the original bytes back", async () => {
    const r = await get(server, "/releases/k/", { "accept-encoding": "br, gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers.vary).toMatch(/Accept-Encoding/i);
    expect(r.headers["cache-control"]).toBe("public, max-age=60");
    expect(Number(r.headers["content-length"])).toBe((await stat(join(dir, "releases/k/index.html.br"))).size);
    expect(r.body.length).toBe(Number(r.headers["content-length"]));
    expect(decode(r).toString()).toBe(BODY("release k"));
    // It is the stored file's bytes, not a fresh compression.
    expect(r.body.equals(await (await import("node:fs/promises")).readFile(join(dir, "releases/k/index.html.br")))).toBe(true);
  });

  it("sends the stored gzip copy to a client that takes gzip but not brotli", async () => {
    const r = await get(server, "/assets/site.css", { "accept-encoding": "gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(decode(r).toString()).toBe(CSS);
    expect(r.body.equals(await (await import("node:fs/promises")).readFile(join(dir, "assets/site.css.gz")))).toBe(true);
  });

  // The choice is the one `compression` makes: same Accept-Encoding, same answer as a site with no stored copies.
  it.each([
    undefined, "", "br", "gzip", "br, gzip", "gzip, br", "*", "*;q=0", "identity", "identity;q=0", "br;q=0", "br;q=0, gzip", "gzip;q=0, br;q=0",
    "deflate", "deflate, gzip;q=0.5", "br;q=0.5, gzip;q=1", "gzip;q=0.8, br;q=0.8", "gzip;q=0.8, br;q=0.9", "compress, br", "zstd, br", "BR", "br;q=0, gzip;q=0, identity;q=0", "identity;q=0, br;q=0", "gzip;q=0.001", "br;q=0.0",
  ])("Accept-Encoding %j: same encoding as per-request compression would pick", async (ae) => {
    const headers: Record<string, string> = ae === undefined ? {} : { "accept-encoding": ae };
    const a = await get(server, "/", headers);
    const b = await get(plain, "/", headers);
    expect(a.headers["content-encoding"], String(ae)).toBe(b.headers["content-encoding"]);
    expect(decode(a).toString()).toBe(BODY("home"));
    expect(decode(b).toString()).toBe(BODY("home"));
    expect(a.status).toBe(b.status);
  });

  it("a response without Accept-Encoding is identity and still says Vary: Accept-Encoding", async () => {
    const r = await get(server, "/assets/site.css");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers.vary).toMatch(/Accept-Encoding/i);
    expect(r.body.toString()).toBe(CSS);
  });

  it("ignores a companion older than its file and compresses per request instead", async () => {
    const old = new Date(Date.now() - 60_000);
    await writeFile(join(dir, "releases/k/index.html"), BODY("release k, edited"));
    await utimes(join(dir, "releases/k/index.html.br"), old, old); // the stored copy predates the edit
    const r = await get(server, "/releases/k/", { "accept-encoding": "br" });
    expect(r.headers["content-encoding"]).toBe("br");
    expect(decode(r).toString()).toBe(BODY("release k, edited"));
    expect(String(r.headers.etag)).not.toMatch(/-br"$/); // identity's own etag: per-request compression, not the stored file
    // gzip's copy is stale too (the page was rewritten after it)
    const g = await fsStorage(dir).write("releases/k/index.html", BODY("release k")); // restore through the writer: fresh again
    void g;
    const again = await get(server, "/releases/k/", { "accept-encoding": "br" });
    expect(String(again.headers.etag)).toMatch(/-br"$/);
    expect(decode(again).toString()).toBe(BODY("release k"));
  });

  it("a missing companion falls back to per-request compression", async () => {
    await rm(join(dir, "assets/site.css.br"));
    const r = await get(server, "/assets/site.css", { "accept-encoding": "br, gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip"); // the other stored copy
    await rm(join(dir, "assets/site.css.gz"));
    const f = await get(server, "/assets/site.css", { "accept-encoding": "br, gzip" });
    expect(f.headers["content-encoding"]).toBe("br");
    expect(decode(f).toString()).toBe(CSS);
    await fsStorage(dir).write("assets/site.css", CSS);
  });

  it("HEAD: same headers as GET (length of the stored copy, encoding), no body", async () => {
    const h = await get(server, "/", { "accept-encoding": "br" }, "HEAD");
    const g = await get(server, "/", { "accept-encoding": "br" });
    expect(h.status).toBe(200);
    expect(h.body.length).toBe(0);
    for (const k of ["content-encoding", "content-length", "content-type", "etag", "cache-control", "vary"]) expect(h.headers[k], k).toBe(g.headers[k]);
  });

  it("ETag differs per encoding; a conditional request matches only its own variant", async () => {
    const br = await get(server, "/", { "accept-encoding": "br" });
    const gz = await get(server, "/", { "accept-encoding": "gzip" });
    const id = await get(server, "/");
    expect(new Set([br.headers.etag, gz.headers.etag, id.headers.etag]).size).toBe(3);
    const hit = await get(server, "/", { "accept-encoding": "br", "if-none-match": String(br.headers.etag) });
    expect(hit.status).toBe(304);
    expect(hit.headers.etag).toBe(br.headers.etag);
    expect(hit.headers.vary).toMatch(/Accept-Encoding/i);
    const miss = await get(server, "/", { "accept-encoding": "br", "if-none-match": String(gz.headers.etag) });
    expect(miss.status).toBe(200);
  });

  it("a Range request gets the page's own bytes, never a slice of an encoded body", async () => {
    const r = await get(server, "/assets/site.css", { "accept-encoding": "br", range: "bytes=0-9" });
    expect(r.status).toBe(206);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["content-range"]).toBe(`bytes 0-9/${CSS.length}`);
    expect(r.body.toString()).toBe(CSS.slice(0, 10));
  });

  it("the .br and .gz files are not pages: their own URLs are the site 404, in any case, with or without Accept-Encoding", async () => {
    for (const path of ["/releases/k/index.html.br", "/releases/k/index.html.gz", "/RELEASES/K/INDEX.HTML.BR", "/assets/site.css.Gz", "/404.html.br", "/nothing.br"]) {
      for (const headers of [{}, { "accept-encoding": "br" }] as Record<string, string>[]) {
        let r = await get(server, path, headers);
        // The legacy URL rules may first send a mis-cased path to its canonical one (one hop); that one is the 404.
        if (r.status === 301) r = await get(server, String(r.headers.location), headers);
        expect(r.status, path).toBe(404);
        expect(decode(r).toString(), path).toContain("site 404");
        expect(r.headers["content-type"], path).toMatch(/^text\/html/);
        expect(r.headers["cache-control"]).toBe("no-store");
      }
    }
    expect((await get(prefixed, "/site/releases/k/index.html.br")).status).toBe(404);
    expect((await get(prefixed, "/site/releases/k/", { "accept-encoding": "br" })).headers["content-encoding"]).toBe("br");
  });

  it("feeds keep their RSS/Atom types when served from the stored copy", async () => {
    const rss = await get(server, "/feed.xml", { "accept-encoding": "br" });
    expect(rss.headers["content-encoding"]).toBe("br");
    expect(rss.headers["content-type"]).toBe("application/rss+xml; charset=utf-8");
    const atom = await get(server, "/atom.xml", { "accept-encoding": "gzip" });
    expect(atom.headers["content-type"]).toBe("application/atom+xml; charset=utf-8");
    expect(decode(atom).toString()).toBe(FEED);
  });

  it("every stored copy is served with the Content-Type express.static gives the original", async () => {
    for (const path of ["/", "/assets/site.css", "/feed.xml"]) {
      const enc = await get(server, path, { "accept-encoding": "gzip" });
      const id = await get(plain, path, { "accept-encoding": "identity" });
      expect(enc.headers["content-type"], path).toBe(id.headers["content-type"]);
    }
  });

  it("binary, tiny and dot files are untouched", async () => {
    const png = await get(server, "/photo.png", { "accept-encoding": "br" });
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.body.equals(PNG)).toBe(true);
    const tiny = await get(server, "/tiny.html", { "accept-encoding": "br" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect((await get(server, "/.site-state.json", { "accept-encoding": "br" })).status).toBe(404);
    const redirect = await get(server, "/releases/k", { "accept-encoding": "br" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers["cache-control"]).toBe("no-store");
  });

  it("the site 404 is served from its stored copy too, still no-store and still a 404", async () => {
    const r = await get(server, "/no/such/page/", { "accept-encoding": "br" });
    expect(r.status).toBe(404);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(decode(r).toString()).toBe(BODY("site 404"));
    expect(r.body.equals(await (await import("node:fs/promises")).readFile(join(dir, "404.html.br")))).toBe(true);
    const id = await get(server, "/no/such/page/");
    expect(id.status).toBe(404);
    expect(id.body.toString()).toBe(BODY("site 404"));
  });
});
