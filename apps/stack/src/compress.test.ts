import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { noStoreByDefault } from "./cache-control";
import { textCompression } from "./compress";

/** Raw HTTP, so the test controls Accept-Encoding exactly (fetch and supertest add their own) and sees the bytes on the wire. */
function get(server: Server, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
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

const decode = (r: { headers: IncomingHttpHeaders; body: Buffer }) =>
  (r.headers["content-encoding"] === "br" ? brotliDecompressSync(r.body) : r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.body).toString("utf8");

const TEXT = "body { color: #013366; }\n".repeat(400); // ~10 KB, well over the 1 KB threshold
const FILES: Record<string, string | Buffer> = {
  "page.html": `<!doctype html><title>x</title>${TEXT}`,
  "site.css": TEXT,
  "site.js": `// ${TEXT}`,
  "data.json": JSON.stringify({ text: TEXT }),
  "icons.svg": `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${TEXT} --></svg>`,
  "sitemap.xml": `<?xml version="1.0"?><urlset><!-- ${TEXT} --></urlset>`,
  "font.woff2": Buffer.alloc(8192, 7),
  "photo.png": Buffer.alloc(8192, 7),
  "tiny.css": "a{}",
};

describe("textCompression", () => {
  let dir: string;
  let server: Server;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gcpe-compress-"));
    for (const [name, body] of Object.entries(FILES)) await writeFile(join(dir, name), body);
    const app = express();
    app.use(textCompression());
    app.use("/static", express.static(dir));
    // Ahead of noStoreByDefault, which would replace the header with no-store.
    app.get("/no-transform", (_req, res) => {
      res.set("Cache-Control", "no-transform");
      res.type("text/plain").send(TEXT);
    });
    app.use(noStoreByDefault);
    app.get("/api/json", (_req, res) => void res.json({ text: TEXT }));
    // A response another layer already encoded: passed through untouched, never encoded twice.
    app.get("/pre-encoded", (_req, res) => {
      res.set({ "Content-Type": "text/plain", "Content-Encoding": "gzip" });
      res.end(Buffer.from("not really gzip, but already marked as encoded".repeat(50)));
    });
    // A streamed body (NoD's CSV reports write chunk by chunk and wait for "drain").
    app.get("/stream.csv", async (_req, res) => {
      res.type("text/csv");
      for (let i = 0; i < 2000; i++) {
        if (!res.write(`${i},row ${i},"some quoted text"\n`)) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["page.html", "site.css", "site.js", "data.json", "icons.svg", "sitemap.xml"])("compresses %s with brotli when the client accepts it, with Vary: Accept-Encoding and no Content-Length", async (name) => {
    const r = await get(server, `/static/${name}`, { "Accept-Encoding": "gzip, deflate, br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers.vary).toMatch(/accept-encoding/i);
    expect(r.headers["content-length"]).toBeUndefined();
    expect(r.body.length).toBeLessThan(Buffer.byteLength(FILES[name] as string) / 4);
    expect(decode(r)).toBe(FILES[name]);
    // The static mount's own caching survives.
    expect(r.headers["cache-control"]).toBe("public, max-age=0");
  });

  it("falls back to gzip for a client that accepts only gzip", async () => {
    const r = await get(server, "/static/site.css", { "Accept-Encoding": "gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(decode(r)).toBe(TEXT);
  });

  it("sends identity bytes when the request has no Accept-Encoding at all (internal fetch, curl without --compressed)", async () => {
    const r = await get(server, "/static/site.css");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(TEXT);
    expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(TEXT)));
    // Still Vary, so a shared cache never hands this copy to a client that asked for br, or the reverse.
    expect(r.headers.vary).toMatch(/accept-encoding/i);
  });

  it("sends identity when the client refuses every encoding we offer", async () => {
    const r = await get(server, "/static/site.css", { "Accept-Encoding": "identity" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(TEXT);
  });

  it.each(["font.woff2", "photo.png"])("leaves already-compressed formats (%s) alone", async (name) => {
    const r = await get(server, `/static/${name}`, { "Accept-Encoding": "gzip, br" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.equals(FILES[name] as Buffer)).toBe(true);
  });

  it("leaves a body under 1 KB alone", async () => {
    const r = await get(server, "/static/tiny.css", { "Accept-Encoding": "gzip, br" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe("a{}");
  });

  it("compresses a JSON API response and keeps the no-store default", async () => {
    const r = await get(server, "/api/json", { "Accept-Encoding": "br" });
    expect(r.headers["content-encoding"]).toBe("br");
    expect(JSON.parse(decode(r))).toEqual({ text: TEXT });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("never encodes a response twice: one that already carries Content-Encoding passes through", async () => {
    const r = await get(server, "/pre-encoded", { "Accept-Encoding": "gzip, br" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.body.toString("utf8")).toBe("not really gzip, but already marked as encoded".repeat(50));
  });

  it("honours Cache-Control: no-transform", async () => {
    const r = await get(server, "/no-transform", { "Accept-Encoding": "gzip, br" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(TEXT);
  });

  it("does not encode a HEAD response, and its headers match an identity GET", async () => {
    const r = await get(server, "/static/site.css", { "Accept-Encoding": "gzip, br" }, "HEAD");
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.length).toBe(0);
  });

  it("does not compress a 206 partial response, whose Content-Range counts identity bytes", async () => {
    const r = await get(server, "/static/site.css", { "Accept-Encoding": "gzip, br", Range: "bytes=0-1999" });
    expect(r.status).toBe(206);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["content-range"]).toBe(`bytes 0-1999/${Buffer.byteLength(TEXT)}`);
    expect(r.body.toString("utf8")).toBe(TEXT.slice(0, 2000));
  });

  it("a streamed response (res.write + drain) arrives whole and compressed", async () => {
    const r = await get(server, "/stream.csv", { "Accept-Encoding": "gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    const lines = decode(r).trimEnd().split("\n");
    expect(lines).toHaveLength(2000);
    expect(lines[1999]).toBe('1999,row 1999,"some quoted text"');
  });
});
