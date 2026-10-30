import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { recordChanges } from "../changes";
import { absoluteFileItems } from "./public-files";
import type { FilesImportCliOptions } from "./files-options";

/**
 * `import:files` (files-cli.ts): fills in the translation and media-asset lists of posts the
 * legacy SQL importer wrote. Legacy SQL has no file lists — the files live in Azure blob storage
 * and the legacy public API (api.news.gov.bc.ca) lists them per post — so `import:legacy` leaves
 * `translations` and `assets` null. This asks the public API for each such post
 * (`GET /api/Posts/<key>`) and stores its `azureTranslations` / `azureAssets` with absolute file
 * URLs (the same `absoluteFileItems` as `import:public`), plus its `hasTranslations` /
 * `hasMediaAssets`.
 *
 * Which posts: published posts with origin "legacy" whose `translations` and `assets` are both
 * still null (`--refresh`: filled ones too), and by default only those legacy flags as having
 * translations or media assets. news.gov only shows a post's translations when its
 * `HasTranslations` is set and its media assets when `HasMediaAssets` is set, and the public API
 * only lists them then (`null`, not `[]`, otherwise), so the flags lose nothing and cut the run
 * to about a tenth of the archive. `--all` asks for every legacy post; `--keys` asks for exactly
 * those posts.
 *
 * Writes go one post per transaction, under the same per-key lock as `applyRelease`, and only to
 * a row that is still origin "legacy" (never one NRMS has published since). Each changed post
 * records one `post.upserted` change, so the public site rebuilds its page on the next
 * `site.sync`. Like the legacy importer, nothing else is written: no `outbox_events` row (so no
 * NRMS, NoD or distribution delivery), no PostUpdate NOTIFY.
 */

export const FILES_IMPORT_USER_AGENT = "gcpe-cutover-files (contact Paul@mtheory.ca)";
/** The tenant's zone, for `--since`. */
const SINCE_ZONE = "America/Vancouver";
const V = "api-version=1.0";

/** A 429 from the source: no further request is sent. */
export class FilesRateLimitedError extends Error {
  constructor(path: string) {
    super(`the legacy API answered 429 Too Many Requests for ${path}`);
    this.name = "FilesRateLimitedError";
  }
}

/** `--max-requests` reached: no further request is sent. */
export class RequestBudgetExhaustedError extends Error {
  constructor(max: number) {
    super(`--max-requests ${max} reached`);
    this.name = "RequestBudgetExhaustedError";
  }
}

/**
 * Request start times for `concurrency` workers: each worker starts at most one request every
 * `intervalMs`, and all of them together at most `concurrency` per `intervalMs` (starts are at
 * least `intervalMs / concurrency` apart). A slot is reserved synchronously, so concurrent
 * callers never get the same one.
 */
export function createLimiter(opts: { intervalMs: number; concurrency: number; now: () => number }) {
  const gap = opts.intervalMs / opts.concurrency;
  let nextGlobal = -Infinity;
  const lastByWorker = new Map<number, number>();
  return {
    /** The time `worker` may start its next request (now or later). */
    reserve(worker: number): number {
      const start = Math.max(opts.now(), nextGlobal, (lastByWorker.get(worker) ?? -Infinity) + opts.intervalMs);
      nextGlobal = start + gap;
      lastByWorker.set(worker, start);
      return start;
    },
  };
}

export type FetchedPost =
  | { status: "found"; dto: Record<string, unknown> }
  /** 404, or the legacy API's empty 200 for a missing post. */
  | { status: "not-found"; httpStatus: number }
  | { status: "failed"; httpStatus: number };

export interface FilesApiClient {
  getPost(key: string, worker: number): Promise<FetchedPost>;
  /** Requests actually sent, retries included. */
  readonly requests: number;
}

export interface FilesApiClientOptions {
  base: string;
  concurrency: number;
  /** Per worker, between request starts (default 1000). */
  intervalMs?: number;
  /** 0: no cap. */
  maxRequests?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createFilesApiClient(opts: FilesApiClientOptions): FilesApiClient {
  const base = opts.base.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const limiter = createLimiter({ intervalMs: opts.intervalMs ?? 1000, concurrency: opts.concurrency, now });
  const max = opts.maxRequests ?? 0;
  let reserved = 0;
  let requests = 0;
  let rateLimited = false;

  const once = async (path: string, worker: number): Promise<Response> => {
    if (rateLimited) throw new FilesRateLimitedError(path);
    // Budget and slot are taken synchronously, so concurrent workers can't overshoot either.
    if (max > 0 && reserved >= max) throw new RequestBudgetExhaustedError(max);
    reserved++;
    // Until the clock really reaches the slot, not one sleep: a timer may fire early by the clock's
    // granularity (about 15 ms on Windows), which started requests ~85 ms apart instead of 100.
    const slot = limiter.reserve(worker);
    for (let wait = slot - now(); wait > 0; wait = slot - now()) await sleep(wait);
    // Another worker met a 429 while this one waited: send nothing more.
    if (rateLimited) throw new FilesRateLimitedError(path);
    requests++;
    return doFetch(base + path, {
      headers: { "user-agent": FILES_IMPORT_USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  };

  return {
    get requests() {
      return requests;
    },
    async getPost(key, worker) {
      const path = `/api/Posts/${encodeURIComponent(key)}?${V}`;
      let res = await once(path, worker);
      if (res.status >= 500) {
        opts.log?.(`[import:files] ${res.status} for ${path}; retrying once`);
        await res.body?.cancel();
        res = await once(path, worker);
      }
      if (res.status === 429) {
        rateLimited = true;
        throw new FilesRateLimitedError(path);
      }
      if (res.status === 404) return { status: "not-found", httpStatus: 404 };
      if (!res.ok) return { status: "failed", httpStatus: res.status };
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text.trim() === "" ? null : JSON.parse(text);
      } catch {
        return { status: "failed", httpStatus: res.status }; // not JSON (an error page): counted, the run goes on
      }
      if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).key !== "string") return { status: "not-found", httpStatus: res.status };
      if (((body as Record<string, unknown>).key as string).toLowerCase() !== key.toLowerCase()) return { status: "failed", httpStatus: res.status };
      return { status: "found", dto: body as Record<string, unknown> };
    },
  };
}

// ---------------------------------------------------------------- which posts

export interface Candidate {
  key: string;
  publishDate: Date;
}

/** Published legacy-imported posts to fetch, newest first. */
export async function findCandidates(db: DbOrTx, o: Pick<FilesImportCliOptions, "since" | "keys" | "refresh" | "all">): Promise<Candidate[]> {
  const conditions = [sql`origin = 'legacy'`, sql`is_published`];
  if (!o.refresh) conditions.push(sql`translations IS NULL AND assets IS NULL`);
  if (o.keys.length > 0) conditions.push(sql`lower(key) IN (SELECT lower(value) FROM jsonb_array_elements_text(${JSON.stringify(o.keys)}::jsonb))`);
  else if (!o.all) conditions.push(sql`(has_translations OR has_media_assets)`);
  if (o.since) conditions.push(sql`(publish_date AT TIME ZONE ${SINCE_ZONE})::date >= ${o.since}::date`);
  const { rows } = await db.execute<{ key: string; publish_date: string | Date }>(
    sql`SELECT key, publish_date FROM posts WHERE ${sql.join(conditions, sql` AND `)} ORDER BY publish_date DESC, key`,
  );
  return rows.map((r) => ({ key: r.key, publishDate: new Date(r.publish_date) }));
}

/**
 * Throws when this database's legacy posts look imported before `import:legacy` carried legacy's
 * `HasTranslations` flag (at least `threshold` legacy posts, none flagged): the default (flagged
 * only) run would then silently skip every translation.
 */
export async function assertTranslationFlagsImported(db: DbOrTx, threshold: number): Promise<void> {
  const { rows } = await db.execute<{ legacy: number; flagged: number }>(sql`
    SELECT count(*)::int AS legacy, count(*) FILTER (WHERE has_translations)::int AS flagged FROM posts WHERE origin = 'legacy'`);
  const { legacy, flagged } = rows[0]!;
  if (legacy >= threshold && flagged === 0) {
    throw new Error(
      `none of the ${legacy} legacy-imported posts has has_translations set: they were imported before import:legacy carried legacy's HasTranslations flag. ` +
        `Re-run import:legacy first (it keeps everything else), or pass --all to ask for every legacy post (about ten times the requests).`,
    );
  }
}

// ---------------------------------------------------------------- the write

export interface PostFiles {
  translations: unknown[] | null;
  assets: unknown[] | null;
  hasTranslations: boolean;
  hasMediaAssets: boolean;
}

export type WriteOutcome = "filled" | "unchanged" | "event-owned" | "gone";

/** JSON with object keys sorted (jsonb doesn't keep key order), for comparing stored lists. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

/**
 * Sets only the four file columns of one legacy post and records `post.upserted`, in one
 * transaction under `applyRelease`'s per-key lock. A post NRMS has published since (origin
 * "event"), or one that is gone, is left alone; one already holding exactly these values is not
 * written (no change row).
 */
export async function applyPostFiles(db: Db, key: string, files: PostFiles): Promise<WriteOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"posts"} || ':' || lower(${key})))`);
    const { rows } = await tx.execute<{ key: string; origin: string; translations: unknown; assets: unknown; has_translations: boolean; has_media_assets: boolean }>(
      sql`SELECT key, origin, translations, assets, has_translations, has_media_assets FROM posts WHERE lower(key) = lower(${key})`,
    );
    const row = rows[0];
    if (!row) return "gone";
    if (row.origin !== "legacy") return "event-owned";
    if (
      canonical(row.translations) === canonical(files.translations) &&
      canonical(row.assets) === canonical(files.assets) &&
      row.has_translations === files.hasTranslations &&
      row.has_media_assets === files.hasMediaAssets
    ) {
      return "unchanged";
    }
    const updated = await tx.execute(sql`
      UPDATE posts SET
        translations = ${files.translations === null ? null : JSON.stringify(files.translations)}::jsonb,
        assets = ${files.assets === null ? null : JSON.stringify(files.assets)}::jsonb,
        has_translations = ${files.hasTranslations},
        has_media_assets = ${files.hasMediaAssets}
      WHERE key = ${row.key} AND origin = 'legacy'
      RETURNING key`);
    if (updated.rows.length === 0) return "event-owned";
    await recordChanges(tx, [{ kind: "post.upserted", key: row.key }]);
    return "filled";
  });
}

/** The four file columns a public PostDto gives, with absolute file URLs (throws on an unsupported key). */
export function filesFromDto(dto: Record<string, unknown>, filesBase: string): PostFiles {
  return {
    translations: absoluteFileItems(dto.azureTranslations, "translations", filesBase),
    assets: absoluteFileItems(dto.azureAssets, "assets", filesBase),
    hasTranslations: dto.hasTranslations === true,
    hasMediaAssets: dto.hasMediaAssets === true,
  };
}

// ---------------------------------------------------------------- the run

export interface FilesImportReport {
  mode: "import" | "dry-run";
  candidates: number;
  /** At one request a second per worker, if every candidate is asked for once. */
  estimate: { requests: number; hours: number; concurrency: number };
  /** A dry run's first candidates. */
  sample?: string[];
  requests: number;
  /** Posts whose file columns were written (one change row each). */
  filled: number;
  /** Fetched, and the database already held exactly that. */
  unchanged: number;
  /** Fetched, with no translation or asset list (the source answered null for both): stored as two empty lists, so a plain re-run skips it. */
  withoutFiles: number;
  /** 404 (or an empty answer) from the source: the post is gone or unpublished there. */
  notFound: string[];
  /** Any other non-2xx after the one retry on a 5xx. */
  failed: { key: string; status: number }[];
  /** A file key the importer can't make absolute; the post is not written. */
  invalid: { key: string; issue: string }[];
  /** NRMS published the key while this ran (origin "event"): left alone. */
  skippedEventOwned: string[];
  /** Candidates not asked for because the run stopped. */
  remaining: number;
  stopped: null | "rate-limited" | "max-requests";
  /** How to carry on after a stop. */
  resume: string | null;
  /** The oldest publish date among the posts handled (newest first), as YYYY-MM-DD. */
  reachedPublishDate: string | null;
}

const hours = (requests: number, concurrency: number) => Math.round((requests / concurrency / 3600) * 100) / 100;

export async function runFilesImport(
  deps: { db: Db; client: FilesApiClient },
  o: FilesImportCliOptions,
  opts: { log?: (msg: string) => void; staleFlagsThreshold?: number; progressEvery?: number } = {},
): Promise<FilesImportReport> {
  const log = opts.log ?? (() => {});
  if (!o.all && o.keys.length === 0) await assertTranslationFlagsImported(deps.db, opts.staleFlagsThreshold ?? 1000);
  const candidates = await findCandidates(deps.db, o);
  const estimate = { requests: candidates.length, hours: hours(candidates.length, o.concurrency), concurrency: o.concurrency };
  const report: FilesImportReport = {
    mode: o.dryRun ? "dry-run" : "import", candidates: candidates.length, estimate, requests: 0, filled: 0, unchanged: 0, withoutFiles: 0,
    notFound: [], failed: [], invalid: [], skippedEventOwned: [], remaining: 0, stopped: null, resume: null, reachedPublishDate: null,
  };
  log(`[import:files] ${candidates.length} post(s) to ask for${o.all ? " (--all)" : o.keys.length ? " (--keys)" : " (flagged in legacy)"}${o.refresh ? ", filled ones included (--refresh)" : ""}${o.since ? ` published on or after ${o.since}` : ""}: about ${estimate.hours} h at --concurrency ${o.concurrency}`);
  if (o.dryRun) {
    report.sample = candidates.slice(0, 20).map((c) => c.key);
    return report;
  }

  let next = 0;
  let done = 0;
  let oldest: Date | null = null;
  let stop: FilesImportReport["stopped"] = null;
  let fatal: unknown = null;
  const every = opts.progressEvery ?? 100;

  const write = async (key: string, dto: Record<string, unknown>) => {
    let files: PostFiles;
    try {
      files = filesFromDto(dto, o.filesBase);
    } catch (e) {
      report.invalid.push({ key, issue: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (files.translations === null && files.assets === null) {
      // Checked, nothing listed: store empty lists, so a plain re-run doesn't ask again
      // (`--refresh` still does). Both views treat [] as no list.
      report.withoutFiles++;
      files = { ...files, translations: [], assets: [] };
    }
    const outcome = await applyPostFiles(deps.db, key, files);
    if (outcome === "filled") report.filled++;
    else if (outcome === "unchanged") report.unchanged++;
    else if (outcome === "event-owned") report.skippedEventOwned.push(key);
    else report.notFound.push(key);
  };

  const worker = async (id: number) => {
    while (!stop && fatal === null && next < candidates.length) {
      const c = candidates[next++]!;
      let fetched: FetchedPost;
      try {
        fetched = await deps.client.getPost(c.key, id);
      } catch (e) {
        if (e instanceof FilesRateLimitedError) stop = "rate-limited";
        else if (e instanceof RequestBudgetExhaustedError) stop ??= "max-requests";
        else fatal ??= e;
        return; // `c` not handled: counted in `remaining`
      }
      try {
        if (fetched.status === "not-found") report.notFound.push(c.key);
        else if (fetched.status === "failed") report.failed.push({ key: c.key, status: fetched.httpStatus });
        else await write(c.key, fetched.dto);
      } catch (e) {
        fatal ??= e;
        return;
      }
      done++;
      if (!oldest || c.publishDate < oldest) oldest = c.publishDate;
      if (done % every === 0) log(`[import:files] ${done}/${candidates.length} done (filled ${report.filled}, not found ${report.notFound.length}, ${deps.client.requests} request(s)), reached ${c.publishDate.toISOString().slice(0, 10)}`);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, (_, i) => worker(i)));
  if (fatal !== null) throw fatal;

  report.requests = deps.client.requests;
  report.remaining = candidates.length - done;
  report.stopped = stop;
  report.reachedPublishDate = oldest === null ? null : (oldest as Date).toISOString().slice(0, 10);
  if (stop === "rate-limited") {
    report.resume =
      `The legacy API answered 429 Too Many Requests: stopped with ${report.remaining} post(s) not asked for (nothing more was sent). ` +
      `Everything filled so far is kept and is skipped next time. Wait an hour or more, then run the same command again (with --concurrency 1 if it was higher); ` +
      `posts are taken newest first, so add --since <date> to cover only recent ones.`;
  } else if (stop === "max-requests") {
    report.resume = `--max-requests ${o.maxRequests} reached with ${report.remaining} post(s) not asked for. Run the same command again to carry on: filled posts are skipped.`;
  }
  log(`[import:files] filled ${report.filled}, unchanged ${report.unchanged}, not found ${report.notFound.length}, failed ${report.failed.length}, invalid ${report.invalid.length}, NRMS-owned ${report.skippedEventOwned.length}, remaining ${report.remaining}, ${report.requests} request(s)`);
  return report;
}
