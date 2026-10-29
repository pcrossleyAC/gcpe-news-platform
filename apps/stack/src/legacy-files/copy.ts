import { createLimiter } from "../../../news-api/src/import/files-run";
import { filesContentPolicy } from "../files-policy";
import { legacyCandidates, normalizeLegacyPath } from "./references";

/**
 * `legacy-files:copy` (cli.ts): imports legacy news.gov.bc.ca `/files/<name>` — the files staff
 * uploaded in the legacy Hub's Website > Files screen (legacy FileManagement.aspx.cs: blobs in
 * the Azure `files` container, stored under the lowercased name with blob metadata `filename` =
 * the name as uploaded) — as NRMS site files, so they are listed in the Hub and served at
 * `/files/<name>` (files-gate.ts).
 *
 * Discovery: with a read+list SAS for the container, the whole container is listed (exact blob
 * names, metadata, sizes, dates). Without one, the paths our content links to (references.ts,
 * sources.ts) are fetched through the public front door, lowercased name first, as legacy did.
 */

export const LEGACY_FILES_USER_AGENT = "gcpe-cutover-legacy-files (contact Paul@mtheory.ca)";
/** Same-host redirects followed per request (Azure normally sends none). */
const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export class LegacyFilesRateLimitedError extends Error {
  constructor() {
    super("the origin answered 429 Too Many Requests");
    this.name = "LegacyFilesRateLimitedError";
  }
}

export class LegacyFilesBudgetError extends Error {
  constructor(max: number) {
    super(`--max-requests ${max} reached`);
    this.name = "LegacyFilesBudgetError";
  }
}

/** A failure for one file: its message is safe to report (no SAS in it). */
class FileFailure extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "FileFailure";
  }
}

/** Where the blobs are read from. */
export type LegacySource =
  /** The public front door: `<origin>/files/<blob>`. Can't list. */
  | { kind: "front-door"; origin: string }
  /** A container SAS URL (`https://<account>.blob.core.windows.net/files?sv=…&sig=…`): reads and lists. Never printed. */
  | { kind: "sas"; containerUrl: string };

export type Fetched =
  | { status: "found"; bytes: Buffer; lastModified: Date | null; metadataFilename: string | null }
  | { status: "not-found" }
  | { status: "failed"; httpStatus?: number; reason: string };

export interface ListedBlob {
  name: string;
  size: number | null;
  lastModified: Date | null;
  metadataFilename: string | null;
}

export interface LegacyFilesClient {
  /** `blob` is the exact blob name (each segment is percent-encoded here). */
  get(blob: string, worker: number): Promise<Fetched>;
  /** Every blob in the container (SAS source only), with metadata. */
  list(): Promise<ListedBlob[]>;
  readonly requests: number;
  /** Removes the SAS (and any `sig=`) from a message. */
  redact(text: string): string;
}

export interface LegacyFilesClientOptions {
  source: LegacySource;
  concurrency: number;
  /** Per worker, between request starts (default 1000). */
  intervalMs?: number;
  /** 0 or absent: no cap. */
  maxRequests?: number;
  /** No response headers within this long: that file fails (default 30 s). */
  headersTimeoutMs?: number;
  /** No body bytes for this long: that file fails (default 60 s). Not a total cap: a slow, steady download goes on. */
  idleTimeoutMs?: number;
  /** A file larger than this fails (default 512 MiB). */
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const encodePath = (blob: string) => blob.split("/").map(encodeURIComponent).join("/");

/** The `<Tag>…</Tag>` text, XML entities decoded. Azure's List Blobs XML is flat enough for this. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
}
function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()]!;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** One page of Azure's List Blobs answer. */
export function parseBlobList(xml: string): { blobs: ListedBlob[]; nextMarker: string | null } {
  const blobs: ListedBlob[] = [];
  for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const b = m[1]!;
    const name = tag(b, "Name");
    if (name === null) continue;
    const size = tag(b, "Content-Length");
    const modified = tag(b, "Last-Modified");
    const metadata = /<Metadata>([\s\S]*?)<\/Metadata>/.exec(b)?.[1] ?? "";
    // Metadata names are case-insensitive in Azure; legacy wrote "filename".
    const filename = /<filename>([\s\S]*?)<\/filename>/i.exec(metadata)?.[1];
    blobs.push({
      name,
      size: size !== null && /^\d+$/.test(size) ? Number(size) : null,
      lastModified: modified ? new Date(modified) : null,
      metadataFilename: filename !== undefined ? decodeXml(filename) : null,
    });
  }
  const next = tag(xml, "NextMarker");
  return { blobs, nextMarker: next ? next : null };
}

export function createLegacyFilesClient(opts: LegacyFilesClientOptions): LegacyFilesClient {
  const sas = opts.source.kind === "sas" ? new URL(opts.source.containerUrl) : null;
  const sasQuery = sas ? sas.search.replace(/^\?/, "") : "";
  const base = sas ? `${sas.origin}${sas.pathname.replace(/\/+$/, "")}` : `${new URL((opts.source as { origin: string }).origin).origin}/files`;
  const origin = new URL(base).origin;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const limiter = createLimiter({ intervalMs: opts.intervalMs ?? 1000, concurrency: opts.concurrency, now });
  const max = opts.maxRequests ?? 0;
  const headersTimeout = opts.headersTimeoutMs ?? 30_000;
  const idleTimeout = opts.idleTimeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let reserved = 0;
  let requests = 0;
  let rateLimited = false;

  const redact = (text: string): string => {
    let t = text;
    if (sasQuery) t = t.split(sasQuery).join("<SAS>");
    return t.replace(/([?&]sig=)[^&\s"']*/gi, "$1<redacted>");
  };
  const withSas = (url: string) => (sasQuery ? `${url}${url.includes("?") ? "&" : "?"}${sasQuery}` : url);

  /** One request: throttled, counted, identity encoding, headers timeout; the caller reads the body. */
  const once = async (url: string, worker: number): Promise<{ res: Response; controller: AbortController }> => {
    if (rateLimited) throw new LegacyFilesRateLimitedError();
    if (max > 0 && reserved >= max) throw new LegacyFilesBudgetError(max);
    reserved++;
    const wait = limiter.reserve(worker) - now();
    if (wait > 0) await sleep(wait);
    if (rateLimited) throw new LegacyFilesRateLimitedError();
    requests++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), controller.abort()), headersTimeout);
    let res: Response;
    try {
      res = await doFetch(url, {
        // Identity: the length check below compares raw bytes. A server that compresses anyway is handled there.
        headers: { "user-agent": LEGACY_FILES_USER_AGENT, "accept-encoding": "identity", "x-ms-version": "2021-08-06" },
        // Never followed automatically: a redirect is checked against the origin below.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      if (timedOut) throw new FileFailure(`no response headers within ${headersTimeout / 1000} s`);
      throw new FileFailure(redact(`request failed: ${e instanceof Error ? `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ""}` : String(e)}`));
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      rateLimited = true;
      await res.body?.cancel();
      throw new LegacyFilesRateLimitedError();
    }
    return { res, controller };
  };

  /** GET with one retry on a 5xx and same-host redirects only. */
  const request = async (url: string, worker: number): Promise<{ res: Response; controller: AbortController }> => {
    let current = url;
    for (let hop = 0; ; hop++) {
      let r = await once(current, worker);
      if (r.res.status >= 500) {
        await r.res.body?.cancel();
        r = await once(current, worker);
      }
      const { res } = r;
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) throw new FileFailure(`redirect ${res.status} without a Location`, res.status);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new FileFailure(`redirect ${res.status} to an unparsable Location`, res.status);
        }
        if (next.origin !== origin) throw new FileFailure(`redirect ${res.status} off the origin host (to ${next.host}): not followed`, res.status);
        if (hop >= MAX_REDIRECTS) throw new FileFailure(`more than ${MAX_REDIRECTS} redirects`, res.status);
        current = next.href;
        continue;
      }
      return r;
    }
  };

  /** The whole body, with the idle timeout, the size cap and (uncompressed only) the length check. */
  const readBody = async (res: Response, controller: AbortController): Promise<Buffer> => {
    const encoded = res.headers.get("content-encoding") !== null && res.headers.get("content-encoding")!.toLowerCase() !== "identity";
    const header = res.headers.get("content-length");
    const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
    if (declared !== null && !encoded && declared > maxBytes) {
      controller.abort();
      throw new FileFailure(`larger than ${maxBytes} bytes (Content-Length ${declared})`);
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<"idle">((r) => (timer = setTimeout(() => r("idle"), idleTimeout)));
      let step: ReadableStreamReadResult<Uint8Array> | "idle";
      try {
        step = await Promise.race([reader.read(), idle]);
      } catch (e) {
        throw new FileFailure(redact(`body failed after ${total} bytes: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        clearTimeout(timer);
      }
      if (step === "idle") {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw new FileFailure(`no data for ${idleTimeout / 1000} s after ${total} bytes`);
      }
      if (step.done) break;
      total += step.value.length;
      if (total > maxBytes) {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw new FileFailure(`larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(step.value));
    }
    // A compressed answer (sent despite identity) is decompressed by fetch: its length is not comparable.
    if (declared !== null && !encoded && total !== declared) throw new FileFailure(`body ended after ${total} of ${declared} bytes`);
    return Buffer.concat(chunks, total);
  };

  return {
    get requests() {
      return requests;
    },
    redact,
    async get(blob, worker) {
      try {
        const { res, controller } = await request(withSas(`${base}/${encodePath(blob)}`), worker);
        if (res.status === 404) {
          await res.body?.cancel();
          return { status: "not-found" };
        }
        if (!res.ok) {
          await res.body?.cancel();
          return { status: "failed", httpStatus: res.status, reason: `HTTP ${res.status}` };
        }
        const bytes = await readBody(res, controller);
        const modified = res.headers.get("last-modified");
        const meta = res.headers.get("x-ms-meta-filename");
        return { status: "found", bytes, lastModified: modified ? new Date(modified) : null, metadataFilename: meta ? decodeMetaHeader(meta) : null };
      } catch (e) {
        if (e instanceof FileFailure) return { status: "failed", ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}), reason: e.message };
        throw e;
      }
    },
    async list() {
      if (!sas) throw new Error("listing needs a SAS URL for the container");
      const out: ListedBlob[] = [];
      let marker: string | null = null;
      do {
        const url = withSas(`${base}?restype=container&comp=list&include=metadata&maxresults=5000${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`);
        let r: { res: Response; controller: AbortController };
        try {
          r = await request(url, 0);
        } catch (e) {
          if (e instanceof FileFailure) throw new Error(`listing the container failed: ${e.message}`);
          throw e;
        }
        if (!r.res.ok) {
          await r.res.body?.cancel();
          throw new Error(`listing the container failed: HTTP ${r.res.status} (is the SAS valid, unexpired, with read and list permissions?)`);
        }
        const page = parseBlobList(await r.res.text());
        out.push(...page.blobs);
        marker = page.nextMarker;
      } while (marker);
      return out;
    },
  };
}

/** Azure returns metadata values as sent; legacy's .NET client sent them as-is (ASCII in practice). Percent-encoded values are decoded when valid. */
function decodeMetaHeader(v: string): string {
  try {
    return /%[0-9a-f]{2}/i.test(v) ? decodeURIComponent(v) : v;
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------- the run

/** Where imported files go: NRMS site files (target.ts), or a fake in tests. */
export interface LegacyFilesTarget {
  /** A site file of that name exists, in any letter case. */
  exists(name: string): Promise<boolean>;
  import(file: { name: string; bytes: Buffer; contentType: string; createdAt: Date; replace: boolean }): Promise<"imported" | "replaced" | "exists">;
}

export interface LegacyFilesCopyOptions {
  /** SAS mode: the container listing. */
  listed?: ListedBlob[];
  /** Reference mode: normalized paths (references.ts), any letter case. */
  paths?: string[];
  dryRun: boolean;
  /** Fetch files already imported again, replacing their bytes. */
  refresh: boolean;
  concurrency: number;
  /** For the dry run's over-cap count (default 512 MiB). */
  maxBytes?: number;
}

export interface LegacyFilesCopyReport {
  mode: "copy" | "dry-run";
  source: "sas-listing" | "references";
  /** SAS mode: blobs listed. Reference mode: paths given. */
  found: number;
  /** Distinct files to import (by name, case-insensitively). */
  files: number;
  /** SAS mode: their total size per the listing (reference mode: null). */
  totalBytes: number | null;
  /** Dry run. */
  alreadyImported?: number;
  toFetch?: number;
  overSizeCap?: number;
  sample?: string[];
  /** Blobs or paths with a "/" (not top-level files, which is all the legacy Hub's Files screen made): not importable as site files; the 302 safety net covers them. */
  nested: string[];
  /** Names that can't be served as /files/<name>, with why. */
  invalid: { name: string; reason: string }[];
  /** Blobs whose name another blob already took (case-insensitively): the lowercased blob, which legacy served first, is kept. */
  duplicates: string[];
  requests: number;
  imported: number;
  replaced: number;
  bytes: number;
  /** Already a site file of that name (any case; a staff upload included): left alone. */
  skipped: number;
  notFound: string[];
  failed: { name: string; status?: number; reason: string }[];
  remaining: number;
  stopped: null | "rate-limited" | "max-requests";
  resume: string | null;
}

interface Item {
  /** The public name (`/files/<name>`), case kept. */
  name: string;
  /** Blob names to ask for, in order. */
  candidates: string[];
  size: number | null;
  lastModified: Date | null;
}

/** Validates `name` as one servable /files/<name> segment. */
function nameProblem(name: string): string | null {
  if (name.includes("/")) return "has a /";
  const n = normalizeLegacyPath(encodeURIComponent(name));
  return n.ok ? null : n.reason;
}

function itemsFromListing(listed: ListedBlob[], report: LegacyFilesCopyReport): Item[] {
  // Lowercased blob names first: legacy's resolver tried them first, so they win a case clash.
  const sorted = [...listed].sort((a, b) => Number(a.name !== a.name.toLowerCase()) - Number(b.name !== b.name.toLowerCase()) || a.name.localeCompare(b.name));
  const byName = new Map<string, Item>();
  for (const b of sorted) {
    if (b.name.includes("/")) {
      report.nested.push(b.name);
      continue;
    }
    // The name staff gave it (metadata `filename`), when it is a usable one and names this blob.
    const meta = b.metadataFilename;
    const name = meta && !nameProblem(meta) && meta.toLowerCase() === b.name.toLowerCase() ? meta : b.name;
    const problem = nameProblem(name);
    if (problem) {
      report.invalid.push({ name, reason: problem });
      continue;
    }
    const key = name.toLowerCase();
    if (byName.has(key)) {
      report.duplicates.push(b.name);
      continue;
    }
    byName.set(key, { name, candidates: [b.name], size: b.size, lastModified: b.lastModified });
  }
  return [...byName.values()];
}

function itemsFromPaths(paths: string[], report: LegacyFilesCopyReport): Item[] {
  const byName = new Map<string, Item>();
  for (const p of new Set(paths)) {
    if (p.includes("/")) {
      report.nested.push(p);
      continue;
    }
    const problem = nameProblem(p);
    if (problem) {
      report.invalid.push({ name: p, reason: problem });
      continue;
    }
    const key = p.toLowerCase();
    const it = byName.get(key);
    if (!it) byName.set(key, { name: p, candidates: legacyCandidates(p), size: null, lastModified: null });
    else if (!it.candidates.includes(p)) it.candidates.push(p);
  }
  return [...byName.values()];
}

export async function runLegacyFilesCopy(
  deps: { client: LegacyFilesClient; target: LegacyFilesTarget },
  o: LegacyFilesCopyOptions,
  opts: { log?: (msg: string) => void; progressEvery?: number; now?: () => Date } = {},
): Promise<LegacyFilesCopyReport> {
  const log = opts.log ?? (() => {});
  const fromListing = o.listed !== undefined;
  const report: LegacyFilesCopyReport = {
    mode: o.dryRun ? "dry-run" : "copy",
    source: fromListing ? "sas-listing" : "references",
    found: fromListing ? o.listed!.length : new Set(o.paths ?? []).size,
    files: 0,
    totalBytes: null,
    nested: [],
    invalid: [],
    duplicates: [],
    requests: 0,
    imported: 0,
    replaced: 0,
    bytes: 0,
    skipped: 0,
    notFound: [],
    failed: [],
    remaining: 0,
    stopped: null,
    resume: null,
  };
  const items = fromListing ? itemsFromListing(o.listed!, report) : itemsFromPaths(o.paths ?? [], report);
  report.files = items.length;
  if (fromListing) report.totalBytes = items.reduce((a, i) => a + (i.size ?? 0), 0);

  if (o.dryRun) {
    let have = 0;
    const need: string[] = [];
    for (const it of items) (await deps.target.exists(it.name)) ? have++ : need.push(it.name);
    report.alreadyImported = have;
    report.toFetch = o.refresh ? items.length : need.length;
    report.overSizeCap = items.filter((i) => i.size !== null && i.size > (o.maxBytes ?? DEFAULT_MAX_BYTES)).length;
    report.sample = (o.refresh ? items.map((i) => i.name) : need).slice(0, 20);
    report.requests = deps.client.requests;
    log(`[legacy-files] dry run: ${items.length} file(s)${report.totalBytes !== null ? ` (${report.totalBytes} bytes)` : ""}, ${have} already imported, ${report.toFetch} to fetch; no file downloaded`);
    return report;
  }

  let next = 0;
  let done = 0;
  let stop: LegacyFilesCopyReport["stopped"] = null;
  let fatal: unknown = null;
  const every = opts.progressEvery ?? 100;

  const handle = async (it: Item, worker: number): Promise<void> => {
    if (!o.refresh && (await deps.target.exists(it.name))) {
      report.skipped++;
      return;
    }
    for (const blob of it.candidates) {
      const f = await deps.client.get(blob, worker);
      if (f.status === "not-found") continue;
      if (f.status === "failed") {
        report.failed.push({ name: it.name, ...(f.httpStatus !== undefined ? { status: f.httpStatus } : {}), reason: deps.client.redact(f.reason) });
        return;
      }
      // Reference mode: the blob's own metadata name, when it names this file, beats the link's spelling.
      const meta = f.metadataFilename;
      const name = !fromListing && meta && !nameProblem(meta) && meta.toLowerCase() === it.name.toLowerCase() ? meta : it.name;
      try {
        const outcome = await deps.target.import({ name, bytes: f.bytes, contentType: filesContentPolicy(name).contentType, createdAt: it.lastModified ?? f.lastModified ?? (opts.now ?? (() => new Date()))(), replace: o.refresh });
        if (outcome === "imported") report.imported++;
        else if (outcome === "replaced") report.replaced++;
        else report.skipped++;
        if (outcome !== "exists") report.bytes += f.bytes.length;
      } catch (e) {
        report.failed.push({ name, reason: deps.client.redact(e instanceof Error ? e.message : String(e)) });
      }
      return;
    }
    report.notFound.push(it.name);
  };

  const worker = async (id: number) => {
    while (!stop && fatal === null && next < items.length) {
      const it = items[next++]!;
      try {
        await handle(it, id);
      } catch (e) {
        if (e instanceof LegacyFilesRateLimitedError) stop = "rate-limited";
        else if (e instanceof LegacyFilesBudgetError) stop ??= "max-requests";
        else fatal ??= e;
        return; // `it` not handled: counted in `remaining`
      }
      done++;
      if (done % every === 0) log(`[legacy-files] ${done}/${items.length} done (imported ${report.imported}, skipped ${report.skipped}, not found ${report.notFound.length}, failed ${report.failed.length})`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, (_, i) => worker(i)));
  if (fatal !== null) throw new Error(deps.client.redact(fatal instanceof Error ? fatal.message : String(fatal)));

  report.requests = deps.client.requests;
  report.remaining = items.length - done;
  report.stopped = stop;
  if (stop === "rate-limited") {
    report.resume =
      `The origin answered 429 Too Many Requests: stopped with ${report.remaining} file(s) not handled (nothing more was sent). ` +
      `Everything imported so far is kept and skipped next time. Wait an hour or more, then run the same command again (with --concurrency 1 if it was higher).`;
  } else if (stop === "max-requests") {
    report.resume = `--max-requests reached with ${report.remaining} file(s) not handled. Run the same command again to carry on: imported files are skipped.`;
  }
  log(`[legacy-files] imported ${report.imported}, replaced ${report.replaced} (${report.bytes} bytes), skipped ${report.skipped}, not found ${report.notFound.length}, failed ${report.failed.length}, remaining ${report.remaining}, ${report.requests} request(s)`);
  return report;
}
