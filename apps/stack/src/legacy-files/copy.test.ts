import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore } from "@gcpe/storage";
import { createNrmsTestDb } from "../../../nrms/test/helpers";
import { findSiteFileByName } from "../../../nrms/src/website/files";
import { createLegacyFilesClient, LEGACY_FILES_USER_AGENT, parseBlobList, runLegacyFilesCopy, type LegacyFilesClientOptions, type LegacyFilesTarget } from "./copy";
import { parseLegacyFilesArgs, parseSasUrl } from "./options";
import { nrmsSiteFilesTarget } from "./target";

// ---------------------------------------------------------------- a stub Azure origin

interface Stub {
  origin: string;
  /** Blob name (case-sensitive, as Azure) → bytes, metadata filename, last modified. */
  blobs: Map<string, { bytes: Buffer; filename?: string; modified?: Date }>;
  /** Request URLs as received (still encoded). */
  log: string[];
  headers: IncomingHttpHeaders[];
  /** Blob name → custom handler. */
  special: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
  /** Blobs per List Blobs page. */
  pageSize: number;
  close(): Promise<void>;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function startStub(): Promise<Stub> {
  const stub = { blobs: new Map(), log: [], headers: [], special: new Map(), pageSize: 1000 } as unknown as Stub;
  const server: Server = createServer((req, res) => {
    stub.log.push(req.url!);
    stub.headers.push(req.headers);
    const url = new URL(req.url!, "http://stub");
    if (url.searchParams.get("comp") === "list" && url.pathname === "/files") {
      const names = [...stub.blobs.keys()].sort();
      const start = Number(url.searchParams.get("marker") ?? 0);
      const page = names.slice(start, start + stub.pageSize);
      const next = start + stub.pageSize < names.length ? String(start + stub.pageSize) : "";
      const body = page
        .map((n) => {
          const b = stub.blobs.get(n)!;
          return `<Blob><Name>${xml(n)}</Name><Properties><Last-Modified>${(b.modified ?? new Date("2020-01-02T03:04:05Z")).toUTCString()}</Last-Modified><Content-Length>${b.bytes.length}</Content-Length></Properties><Metadata>${b.filename ? `<filename>${xml(b.filename)}</filename>` : ""}</Metadata></Blob>`;
        })
        .join("");
      res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${body}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`);
      return;
    }
    const prefix = url.pathname.startsWith("/files/") ? "/files/" : null;
    if (!prefix) return void res.writeHead(404).end();
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    const special = stub.special.get(name);
    if (special) return special(req, res);
    const blob = stub.blobs.get(name);
    if (!blob) return void res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>BlobNotFound</Code></Error>");
    const h: Record<string, string | number> = { "content-type": "application/octet-stream", "content-length": blob.bytes.length, "last-modified": (blob.modified ?? new Date("2020-01-02T03:04:05Z")).toUTCString() };
    if (blob.filename) h["x-ms-meta-filename"] = blob.filename;
    res.writeHead(200, h).end(blob.bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return stub;
}

/** An in-memory target: name (lower case) → the import. */
function memoryTarget() {
  const files = new Map<string, { name: string; bytes: Buffer; contentType: string; createdAt: Date }>();
  const target: LegacyFilesTarget = {
    exists: async (name) => files.has(name.toLowerCase()),
    import: async (f) => {
      const had = files.has(f.name.toLowerCase());
      if (had && !f.replace) return "exists";
      files.set(f.name.toLowerCase(), f);
      return had ? "replaced" : "imported";
    },
  };
  return { files, target };
}

let stub: Stub;
let other: Stub;
beforeAll(async () => {
  stub = await startStub();
  other = await startStub();
});
afterAll(async () => {
  await stub.close();
  await other.close();
});
const reset = () => {
  stub.blobs.clear();
  stub.special.clear();
  stub.log.length = 0;
  stub.headers.length = 0;
  stub.pageSize = 1000;
  other.log.length = 0;
};

const frontDoor = (o: Partial<LegacyFilesClientOptions> = {}) => createLegacyFilesClient({ source: { kind: "front-door", origin: stub.origin }, concurrency: 1, intervalMs: 0, ...o });
const SAS = "sv=2021-08-06&sr=c&sp=rl&se=2026-12-31&sig=SECRETsig%2Bvalue%3D";
const sasClient = (o: Partial<LegacyFilesClientOptions> = {}) => createLegacyFilesClient({ source: { kind: "sas", containerUrl: `${stub.origin}/files?${SAS}` }, concurrency: 1, intervalMs: 0, ...o });
const byPaths = (paths: string[], t = memoryTarget(), o: { dryRun?: boolean; refresh?: boolean; client?: ReturnType<typeof frontDoor> } = {}) =>
  runLegacyFilesCopy({ client: o.client ?? frontDoor(), target: t.target }, { paths, dryRun: o.dryRun ?? false, refresh: o.refresh ?? false, concurrency: 1 });

describe("reference mode (no SAS): the public front door", () => {
  it("imports each file under its name, sends identity encoding and the user agent; a re-run skips it with no request", async () => {
    reset();
    stub.blobs.set("news_footage_license_british_columbia.pdf", { bytes: Buffer.from("%PDF lowercased copy") });
    stub.blobs.set("News_Footage_License_British_Columbia.pdf", { bytes: Buffer.from("%PDF licence") });
    stub.blobs.set("q1_ mediadeck.pdf", { bytes: Buffer.from("deck"), filename: "Q1_ MediaDeck.pdf", modified: new Date("2019-05-06T07:08:09Z") });
    const t = memoryTarget();
    const r = await byPaths(["News_Footage_License_British_Columbia.pdf", "q1_ MEDIADECK.pdf"], t);
    expect(r).toMatchObject({ mode: "copy", source: "references", found: 2, files: 2, imported: 2, skipped: 0, notFound: [], failed: [], remaining: 0, stopped: null });
    // Lowercased first, like legacy; the blob's metadata name wins over the link's spelling.
    expect(stub.log).toEqual(["/files/news_footage_license_british_columbia.pdf", "/files/q1_%20mediadeck.pdf"]);
    expect(t.files.get("q1_ mediadeck.pdf")).toMatchObject({ name: "Q1_ MediaDeck.pdf", contentType: "application/pdf" });
    expect(t.files.get("q1_ mediadeck.pdf")!.createdAt.toISOString()).toBe("2019-05-06T07:08:09.000Z");
    expect(stub.headers.every((h) => h["user-agent"] === LEGACY_FILES_USER_AGENT && h["accept-encoding"] === "identity")).toBe(true);
    stub.log.length = 0;
    expect(await byPaths(["News_Footage_License_British_Columbia.pdf", "Q1_ MediaDeck.pdf"], t)).toMatchObject({ imported: 0, skipped: 2, requests: 0 });
    expect(stub.log).toEqual([]);
  });

  it("falls back to the name as written; nested paths are reported, not fetched; a 404 for every spelling is notFound", async () => {
    reset();
    stub.blobs.set("Mixed.pdf", { bytes: Buffer.from("m") });
    const r = await byPaths(["Mixed.pdf", "Newsroom/x.pdf", "Missing.pdf"]);
    expect(r).toMatchObject({ imported: 1, nested: ["Newsroom/x.pdf"], notFound: ["Missing.pdf"] });
    expect(stub.log).toEqual(["/files/mixed.pdf", "/files/Mixed.pdf", "/files/missing.pdf", "/files/Missing.pdf"]);
  });

  it("a 429 stops the run: nothing more is sent, the rest is remaining", async () => {
    reset();
    for (let i = 0; i < 5; i++) stub.blobs.set(`f${i}.pdf`, { bytes: Buffer.from(`f${i}`) });
    stub.special.set("f2.pdf", (_q, res) => res.writeHead(429).end());
    const r = await byPaths(["f0.pdf", "f1.pdf", "f2.pdf", "f3.pdf", "f4.pdf"]);
    expect(r).toMatchObject({ imported: 2, stopped: "rate-limited", remaining: 3 });
    expect(r.resume).toMatch(/429/);
    expect(stub.log).toHaveLength(3);
  });

  it("follows a redirect on the same host, never one that leaves it; a 5xx is retried once", async () => {
    reset();
    stub.blobs.set("moved-here.pdf", { bytes: Buffer.from("moved") });
    stub.special.set("moved.pdf", (_q, res) => res.writeHead(302, { location: "/files/moved-here.pdf" }).end());
    stub.special.set("away.pdf", (_q, res) => res.writeHead(301, { location: `${other.origin}/files/away.pdf` }).end());
    stub.special.set("sneaky.pdf", (_q, res) => res.writeHead(302, { location: "//127.0.0.2:1/files/sneaky.pdf" }).end());
    stub.special.set("broken.pdf", (_q, res) => res.writeHead(503).end());
    const t = memoryTarget();
    const r = await byPaths(["moved.pdf", "away.pdf", "sneaky.pdf", "broken.pdf"], t);
    expect(t.files.get("moved.pdf")!.bytes.toString()).toBe("moved");
    expect(r.failed.map((f) => f.name)).toEqual(["away.pdf", "sneaky.pdf", "broken.pdf"]);
    expect(r.failed[0]!.reason).toMatch(/off the origin host/);
    expect(r.failed[2]).toEqual({ name: "broken.pdf", status: 503, reason: "HTTP 503" });
    expect(other.log).toEqual([]);
    expect(stub.log.filter((p) => p === "/files/broken.pdf")).toHaveLength(2);
  });

  it("--dry-run sends nothing and counts what is already imported; --refresh replaces", async () => {
    reset();
    stub.blobs.set("doc.pdf", { bytes: Buffer.from("new") });
    const t = memoryTarget();
    await t.target.import({ name: "Doc.pdf", bytes: Buffer.from("old"), contentType: "application/pdf", createdAt: new Date(), replace: false });
    expect(await byPaths(["doc.pdf", "need.pdf"], t, { dryRun: true })).toMatchObject({ mode: "dry-run", files: 2, alreadyImported: 1, toFetch: 1, requests: 0, totalBytes: null });
    expect(stub.log).toEqual([]);
    expect(await byPaths(["doc.pdf"], t, { refresh: true })).toMatchObject({ replaced: 1 });
    expect(t.files.get("doc.pdf")!.bytes.toString()).toBe("new");
  });

  it("--max-requests stops cleanly", async () => {
    reset();
    for (let i = 0; i < 4; i++) stub.blobs.set(`m${i}.pdf`, { bytes: Buffer.from("m") });
    const r = await byPaths(["m0.pdf", "m1.pdf", "m2.pdf", "m3.pdf"], memoryTarget(), { client: frontDoor({ maxRequests: 2 }) });
    expect(r).toMatchObject({ imported: 2, stopped: "max-requests", remaining: 2 });
  });
});

describe("download guards", () => {
  it("a gzipped answer despite identity (Content-Length of the compressed bytes) is stored whole, not refused", async () => {
    reset();
    const plain = Buffer.from("%PDF ".repeat(200));
    const zipped = gzipSync(plain);
    stub.special.set("zipped.pdf", (_q, res) => res.writeHead(200, { "content-encoding": "gzip", "content-length": zipped.length }).end(zipped));
    const t = memoryTarget();
    expect(await byPaths(["zipped.pdf"], t)).toMatchObject({ imported: 1, failed: [] });
    expect(t.files.get("zipped.pdf")!.bytes).toEqual(plain);
  });

  it("a body shorter than its Content-Length fails", async () => {
    reset();
    stub.special.set("cut.pdf", (_q, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("short");
      res.destroy();
    });
    const r = await byPaths(["cut.pdf"]);
    expect(r.imported).toBe(0);
    expect(r.failed.map((f) => f.name)).toEqual(["cut.pdf"]);
  });

  it("a body that goes quiet longer than the idle timeout fails; a slow but steady one is not cut off by a total cap", async () => {
    reset();
    stub.special.set("stall.pdf", (_q, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
    });
    stub.special.set("steady.pdf", (_q, res) => {
      res.writeHead(200);
      let n = 0;
      const t = setInterval(() => {
        res.write("x");
        if (++n === 6) (clearInterval(t), res.end());
      }, 60);
    });
    const t = memoryTarget();
    const r = await byPaths(["stall.pdf", "steady.pdf"], t, { client: frontDoor({ idleTimeoutMs: 150, headersTimeoutMs: 1000 }) });
    expect(r.failed.map((f) => f.name)).toEqual(["stall.pdf"]);
    expect(r.failed[0]!.reason).toMatch(/no data for/);
    expect(t.files.get("steady.pdf")!.bytes.toString()).toBe("xxxxxx");
  });

  it("no response headers within the headers timeout fails that file and the run goes on", async () => {
    reset();
    stub.special.set("silent.pdf", () => {});
    stub.blobs.set("fine.pdf", { bytes: Buffer.from("ok") });
    const r = await byPaths(["silent.pdf", "fine.pdf"], memoryTarget(), { client: frontDoor({ headersTimeoutMs: 150 }) });
    expect(r.failed.map((f) => f.name)).toEqual(["silent.pdf"]);
    expect(r.failed[0]!.reason).toMatch(/no response headers/);
    expect(r.imported).toBe(1);
  });

  it("a file over the size cap fails with a reason, whether its Content-Length says so or the body runs past it", async () => {
    reset();
    stub.special.set("declared.pdf", (_q, res) => res.writeHead(200, { "content-length": "50" }).end("y".repeat(50)));
    stub.special.set("chunked.pdf", (_q, res) => {
      res.writeHead(200);
      res.end("z".repeat(50));
    });
    const r = await byPaths(["declared.pdf", "chunked.pdf"], memoryTarget(), { client: frontDoor({ maxBytes: 20 }) });
    expect(r.imported).toBe(0);
    expect(r.failed.map((f) => f.name)).toEqual(["declared.pdf", "chunked.pdf"]);
    for (const f of r.failed) expect(f.reason).toMatch(/larger than 20 bytes/);
  });
});

describe("SAS mode: the whole container is listed", () => {
  it("parseBlobList reads names, sizes, dates, the filename metadata and the next marker", () => {
    const page = parseBlobList(
      `<EnumerationResults><Blobs><Blob><Name>a &amp; b.pdf</Name><Properties><Last-Modified>Tue, 04 Mar 2019 05:06:07 GMT</Last-Modified><Content-Length>12</Content-Length></Properties><Metadata><FileName>A &amp; B.pdf</FileName></Metadata></Blob><Blob><Name>x.pdf</Name><Properties><Content-Length>1</Content-Length></Properties></Blob></Blobs><NextMarker>m2</NextMarker></EnumerationResults>`,
    );
    expect(page.nextMarker).toBe("m2");
    expect(page.blobs).toEqual([
      { name: "a & b.pdf", size: 12, lastModified: new Date("2019-03-04T05:06:07Z"), metadataFilename: "A & B.pdf" },
      { name: "x.pdf", size: 1, lastModified: null, metadataFilename: null },
    ]);
  });

  it("lists every page with the SAS on each request, fetches exact blob names, names each file by its metadata, keeps the lowercased blob on a case clash, reports nested blobs; the SAS is never in the report", async () => {
    reset();
    stub.pageSize = 2;
    stub.blobs.set("news_footage_license_british_columbia.pdf", { bytes: Buffer.from("%PDF lic"), filename: "News_Footage_License_British_Columbia.pdf", modified: new Date("2018-01-01T00:00:00Z") });
    stub.blobs.set("q1_ mediadeck.pdf", { bytes: Buffer.from("deck"), filename: "Q1_ MediaDeck.pdf" });
    stub.blobs.set("Q1_ MediaDeck.pdf", { bytes: Buffer.from("old as-is copy") });
    stub.blobs.set("plain.docx", { bytes: Buffer.from("PK docx") });
    stub.blobs.set("Newsroom/inner.pdf", { bytes: Buffer.from("nested") });
    stub.special.set("plain.docx", (_q, res) => res.writeHead(500).end());
    const client = sasClient();
    const listed = await client.list();
    expect(listed).toHaveLength(5);
    expect(stub.log.filter((u) => u.includes("comp=list"))).toHaveLength(3);
    const t = memoryTarget();
    const dry = await runLegacyFilesCopy({ client, target: t.target }, { listed, dryRun: true, refresh: false, concurrency: 1 });
    expect(dry).toMatchObject({ source: "sas-listing", found: 5, files: 3, totalBytes: 8 + 4 + 7, alreadyImported: 0, toFetch: 3, nested: ["Newsroom/inner.pdf"], duplicates: ["Q1_ MediaDeck.pdf"] });
    const r = await runLegacyFilesCopy({ client, target: t.target }, { listed, dryRun: false, refresh: false, concurrency: 1 });
    expect(r).toMatchObject({ imported: 2, failed: [{ name: "plain.docx", status: 500, reason: "HTTP 500" }] });
    expect(t.files.get("q1_ mediadeck.pdf")).toMatchObject({ name: "Q1_ MediaDeck.pdf" });
    expect(t.files.get("q1_ mediadeck.pdf")!.bytes.toString()).toBe("deck");
    expect(t.files.get("news_footage_license_british_columbia.pdf")!.createdAt.toISOString()).toBe("2018-01-01T00:00:00.000Z");
    expect(t.files.get("plain.docx")).toBeUndefined();
    const gets = stub.log.filter((u) => !u.includes("comp=list"));
    expect(gets.every((u) => u.includes("sig=SECRETsig%2Bvalue%3D"))).toBe(true);
    expect(gets).toContain(`/files/q1_%20mediadeck.pdf?${SAS}`);
    expect(JSON.stringify([dry, r])).not.toMatch(/SECRET|sig=/);
  });

  it("a failed listing names the problem without the SAS", async () => {
    const client = createLegacyFilesClient({ source: { kind: "sas", containerUrl: `${other.origin}/nope?${SAS}` }, concurrency: 1, intervalMs: 0 });
    const err = await client.list().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toMatch(/listing the container failed: HTTP 404/);
    expect(err!.message).not.toMatch(/SECRET|sig=/);
    expect(client.redact(`GET ${other.origin}/nope?${SAS} failed, also ?sig=abc&x=1`)).not.toMatch(/SECRET|sig=abc/);
  });
});

describe("into NRMS site files (end to end, real NRMS database and store)", () => {
  let tdb: TestDatabase;
  let root: string;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    root = await mkdtemp(join(tmpdir(), "legacy-files-nrms-"));
  });
  afterAll(async () => {
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  it("listed blobs land in site_files (findable in any case, logged as Legacy import); a re-run imports nothing", async () => {
    reset();
    stub.blobs.set("q1_ mediadeck.pdf", { bytes: Buffer.from("%PDF deck"), filename: "Q1_ MediaDeck.pdf", modified: new Date("2019-05-06T07:08:09Z") });
    stub.blobs.set("report.pdf", { bytes: Buffer.from("%PDF report"), filename: "Report.pdf" });
    const store = localStore(root);
    const target = nrmsSiteFilesTarget(tdb.db, store);
    const client = sasClient();
    const first = await runLegacyFilesCopy({ client, target }, { listed: await client.list(), dryRun: false, refresh: false, concurrency: 1 });
    expect(first).toMatchObject({ imported: 2, failed: [] });
    const deck = await findSiteFileByName(tdb.db, "Q1_ MEDIADECK.pdf");
    expect(deck).toMatchObject({ name: "Q1_ MediaDeck.pdf" });
    expect((await store.get(deck!.storageKey))!.bytes.toString()).toBe("%PDF deck");
    expect(await findSiteFileByName(tdb.db, "report.pdf")).toMatchObject({ name: "Report.pdf", storageKey: "report.pdf" });
    const { rows } = await tdb.pool.query("SELECT actor_name, text FROM site_log ORDER BY id");
    expect(rows).toEqual([
      { actor_name: "Legacy import", text: "Imported Q1_ MediaDeck.pdf from legacy" },
      { actor_name: "Legacy import", text: "Imported Report.pdf from legacy" },
    ]);
    const again = await runLegacyFilesCopy({ client, target }, { listed: await client.list(), dryRun: false, refresh: false, concurrency: 1 });
    expect(again).toMatchObject({ imported: 0, skipped: 2 });
  });
});

describe("options", () => {
  it("defaults: the Azure front door, concurrency 1, every database source, 512 MB cap", () => {
    expect(parseLegacyFilesArgs([])).toMatchObject({
      origin: "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net",
      concurrency: 1,
      dryRun: false,
      refresh: false,
      db: true,
      pathsFiles: [],
      scanFiles: [],
      maxRequests: 0,
      maxFileMb: 512,
    });
  });

  it("reads every option; unknown ones are refused", () => {
    const o = parseLegacyFilesArgs(["--dry-run", "--refresh", "--concurrency", "3", "--origin", "https://files.example/", "--paths-file", "a.txt", "--paths-file=b.txt", "--scan-file", "log.txt", "--no-db", "--max-requests", "10", "--max-file-mb", "64"]);
    expect(o).toMatchObject({ dryRun: true, refresh: true, concurrency: 3, origin: "https://files.example", pathsFiles: ["a.txt", "b.txt"], scanFiles: ["log.txt"], db: false, maxRequests: 10, maxFileMb: 64 });
    expect(() => parseLegacyFilesArgs(["--max-file-mb", "0"])).toThrow(/max-file-mb/);
    expect(() => parseLegacyFilesArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseLegacyFilesArgs(["--concurrency", "9"])).toThrow(/1 to 4/);
    expect(() => parseLegacyFilesArgs(["--origin", "http://files.example"])).toThrow(/https/);
    expect(() => parseLegacyFilesArgs(["--origin", "https://files.example/sub"])).toThrow(/origin/);
  });

  it("parseSasUrl: an https container URL with a signature; errors never echo it", () => {
    expect(parseSasUrl("https://acct.blob.core.windows.net/files?sv=1&sp=rl&sig=abc")).toBe("https://acct.blob.core.windows.net/files?sv=1&sp=rl&sig=abc");
    for (const bad of ["http://acct.blob.core.windows.net/files?sig=abc", "https://acct.blob.core.windows.net/files", "https://acct.blob.core.windows.net/?sig=abc", "https://acct.blob.core.windows.net/files/x?sig=abc", "not a url sig=abc"]) {
      let message = "";
      try {
        parseSasUrl(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/LEGACY_FILES_SAS_URL/);
      expect(message).not.toMatch(/abc/);
    }
  });
});
