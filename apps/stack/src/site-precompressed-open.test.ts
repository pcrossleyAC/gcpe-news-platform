import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { fsStorage } from "../../public-site/src/storage";
import { mountSite, rootSiteNotFound } from "./site-mount";

/**
 * The stored copy disappears (or turns unreadable) between the moment the server decides to use it
 * and the moment it reads it: a rewrite renaming a new copy in, a Windows pending delete, EMFILE.
 * `open` from node:fs/promises is wrapped so a test can make the companion's open, or its first
 * read, fail on demand.
 */
const fault = vi.hoisted(() => ({ open: null as null | ((path: string) => Error | null), stream: null as null | ((path: string) => Error | null) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (path: Parameters<typeof real.open>[0], ...rest: unknown[]): Promise<FileHandle> => {
    const p = String(path);
    const openErr = fault.open?.(p) ?? null;
    if (openErr) throw openErr;
    const handle = await (real.open as (...a: unknown[]) => Promise<FileHandle>)(path, ...rest);
    const streamErr = fault.stream?.(p) ?? null;
    if (!streamErr) return handle;
    // A handle whose read fails before the first byte (EIO on a dying disk, say).
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === "createReadStream") {
          return () => {
            const r = new Readable({ read() { this.destroy(streamErr); } });
            r.on("close", () => void target.close().catch(() => {}));
            return r;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  return { ...real, open, default: { ...real, open } };
});

interface Res { status: number; headers: IncomingHttpHeaders; body: Buffer }
function get(server: Server, path: string, headers: Record<string, string> = {}): Promise<Res> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
const eperm = (p: string) => Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: "EPERM" });
const BODY = (label: string) => `<!doctype html><title>${label}</title>` + `<p>government news release body text ${label}</p>\n`.repeat(120);

describe("the stored copy fails between the decision and the read", () => {
  let dir: string;
  let server: Server;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gcpe-precompressed-open-"));
    await fsStorage(dir).write("index.html", BODY("home"));
    await fsStorage(dir).write("404.html", BODY("site 404"));
    const app = express(); // no per-request compression: whatever encoding header arrives was set by the stored-copy path
    mountSite(app, { outputDir: dir, basePath: "" });
    app.use(rootSiteNotFound(dir, ["/api"]));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  });
  afterEach(() => {
    fault.open = null;
    fault.stream = null;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const plainOk = (r: Res, status: number, body: string) => {
    expect(r.status).toBe(status);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(String(r.headers.etag)).not.toMatch(/-(br|gz)"$/);
    expect(r.body.toString()).toBe(body);
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(body));
  };

  for (const [name, make] of [["deleted (ENOENT)", enoent], ["pending delete / locked (EPERM)", eperm]] as const) {
    it(`page: the .br's open fails, ${name}: the plain page, no encoding headers`, async () => {
      fault.open = (p) => (p.endsWith("index.html.br") ? make(p) : null);
      plainOk(await get(server, "/", { "accept-encoding": "br" }), 200, BODY("home"));
    });
    it(`404 page: the .br's open fails, ${name}: the plain 404 page`, async () => {
      fault.open = (p) => (p.endsWith("404.html.br") ? make(p) : null);
      const r = await get(server, "/missing/", { "accept-encoding": "br" });
      plainOk(r, 404, BODY("site 404"));
      expect(r.headers["cache-control"]).toBe("no-store");
    });
  }

  it("the .br's open fails but the .gz opens: the client that takes gzip gets the stored gzip", async () => {
    fault.open = (p) => (p.endsWith(".br") ? enoent(p) : null);
    const r = await get(server, "/", { "accept-encoding": "br, gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(String(r.headers.etag)).toMatch(/-gz"$/);
  });

  it("the .br opens but its first read fails: the plain page, no encoding headers", async () => {
    fault.stream = (p) => (p.endsWith(".br") ? Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }) : null);
    plainOk(await get(server, "/", { "accept-encoding": "br" }), 200, BODY("home"));
    plainOk(await get(server, "/missing/", { "accept-encoding": "br" }), 404, BODY("site 404"));
  });
});
