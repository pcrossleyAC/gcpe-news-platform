import { releaseRecordSchema, type CategoryKind, type ReleaseRecord } from "@gcpe/events";
import { postToRelease } from "../dev/fixture-world";
import { absoluteFileItems, DEFAULT_FILES_BASE } from "./public-files";

/**
 * Fetching a slice of posts from the public, read-only legacy News API (api.news.gov.bc.ca) for
 * `import:public` (public-cli.ts). Politeness is built in, not left to the caller: one request
 * at a time, at least `minIntervalMs` apart, a fixed User-Agent, one retry on a 5xx and none on
 * anything else, and a 429 stops the whole run.
 */

export const DEFAULT_PUBLIC_API_BASE = "https://api.news.gov.bc.ca";
export const PUBLIC_IMPORT_USER_AGENT = "gcpe-boxs-test-import (contact Paul@mtheory.ca)";
/** The `postKind` values the legacy API's Latest accepts (each probed live 2026-10-28). */
export const PUBLIC_POST_KINDS = ["releases", "stories", "factsheets", "updates"] as const;
/** The legacy list route of each category kind. */
export const CATEGORY_LIST_PATHS: Record<CategoryKind, string> = { ministries: "Ministries", sectors: "Sectors", themes: "Themes", tags: "Tags" };
const CATEGORY_KINDS = Object.keys(CATEGORY_LIST_PATHS) as CategoryKind[];
/** Keys per `GET /api/Posts?postKeys=` request. */
export const KEYS_PER_REQUEST = 10;
const V = "api-version=1.0";

/** A 429 from the source: the run stops (nothing is written). */
export class RateLimitedError extends Error {
  constructor(path: string) {
    super(`the public API answered 429 Too Many Requests for ${path}; stopping`);
    this.name = "RateLimitedError";
  }
}

export interface PublicApiResponse {
  status: number;
  /** Parsed JSON, or null for an empty or non-2xx body (the legacy API answers a missing post with an empty 200). */
  body: unknown;
}

export interface PublicApiClient {
  get(path: string): Promise<PublicApiResponse>;
  /** Requests actually sent, retries included. */
  readonly requests: number;
}

export interface PublicApiClientOptions {
  base: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPublicApiClient(opts: PublicApiClientOptions): PublicApiClient {
  const base = opts.base.replace(/\/+$/, "");
  const minInterval = opts.minIntervalMs ?? 1000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  let last: number | null = null;
  let requests = 0;

  const once = async (path: string): Promise<Response> => {
    if (last !== null) {
      const wait = last + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    requests++;
    try {
      return await doFetch(base + path, {
        headers: { "user-agent": PUBLIC_IMPORT_USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } finally {
      // Measured from the end of a request, so a slow answer never shortens the gap.
      last = now();
    }
  };

  return {
    get requests() {
      return requests;
    },
    async get(path) {
      let res = await once(path);
      if (res.status >= 500) {
        opts.log?.(`[import:public] ${res.status} for ${path}; retrying once`);
        res = await once(path);
      }
      if (res.status === 429) throw new RateLimitedError(path);
      if (!res.ok) return { status: res.status, body: null };
      const text = await res.text();
      return { status: res.status, body: text.trim() === "" ? null : (JSON.parse(text) as unknown) };
    },
  };
}

export interface FetchPlanOptions {
  perKind: number;
  perCategory: number;
  keys: string[];
  maxRequests: number;
  /** Where relative translation/asset keys live (default DEFAULT_FILES_BASE). */
  filesBase?: string;
  log?: (msg: string) => void;
}

type Json = Record<string, unknown>;
const isPostDto = (v: unknown): v is Json & { key: string } =>
  !!v && typeof v === "object" && typeof (v as Json).key === "string" && Array.isArray((v as Json).documents);

export interface FetchedSlice {
  /** Valid posts, one per key (case-insensitive), in first-seen order. */
  records: ReleaseRecord[];
  plan: { kindRequests: number; listRequests: number; categoryRequests: number; keyRequests: number; total: number; categoriesSkippedByCap: string[] };
  requests: number;
  /** Posts returned per post kind request (before de-duplication). */
  perKind: Record<string, number>;
  /** Posts returned per category ("ministries:health"), before de-duplication. */
  perCategory: Record<string, number>;
  /** Categories the source lists, per kind. */
  listed: Record<CategoryKind, number>;
  /** Requests answered with something other than a JSON list/post (path → status). */
  failed: { path: string; status: number }[];
  keysNotFound: string[];
  /** Posts the source returned that don't satisfy the release schema (key → first issue); never written. */
  invalid: { key: string; issue: string }[];
  /** Unique posts per post kind. */
  uniqueByKind: Record<string, number>;
  /** Category keys the posts carry that the source's own lists don't (key → posts); only for kinds whose list was fetched. */
  notListedBySource: Record<string, Record<string, number>>;
}

/** The release a public PostDto describes. Never flagged for subscribers or media lists. */
export function publicPostToRelease(dto: Json, filesBase: string = DEFAULT_FILES_BASE): ReleaseRecord {
  const r = postToRelease(dto);
  return { ...r, translations: absoluteFileItems(r.translations, "translations", filesBase), assets: absoluteFileItems(r.assets, "assets", filesBase), publishFlags: { toWeb: true, toSubscribers: false, toMediaLists: false }, mediaListKeys: [], renditions: null, mediaText: null };
}

/**
 * Fetches the slice: the latest `perKind` posts of each post kind on the home index, then the
 * category lists and the latest `perCategory` posts of every listed category, then `keys` in
 * batches. The plan (request count) is logged before the per-category and key requests; when it
 * exceeds `maxRequests`, categories are dropped (taking turns across kinds) until it fits.
 */
export async function fetchPublicSlice(client: PublicApiClient, opts: FetchPlanOptions): Promise<FetchedSlice> {
  const log = opts.log ?? (() => {});
  const seen = new Map<string, Json & { key: string }>();
  const perKind: Record<string, number> = {};
  const perCategory: Record<string, number> = {};
  const failed: FetchedSlice["failed"] = [];
  const listed: Record<CategoryKind, number> = { ministries: 0, sectors: 0, themes: 0, tags: 0 };

  const keyBatches: string[][] = [];
  const keys = [...new Map(opts.keys.map((k) => [k.toLowerCase(), k])).values()];
  for (let i = 0; i < keys.length; i += KEYS_PER_REQUEST) keyBatches.push(keys.slice(i, i + KEYS_PER_REQUEST));
  const kindRequests = opts.perKind > 0 ? PUBLIC_POST_KINDS.length : 0;
  const listRequests = opts.perCategory > 0 ? CATEGORY_KINDS.length : 0;
  log(`[import:public] plan: ${kindRequests} post-kind + ${listRequests} category-list + (per-category, known after the lists) + ${keyBatches.length} by-key request(s)`);
  if (kindRequests + listRequests + keyBatches.length > opts.maxRequests) {
    throw new Error(`the plan needs at least ${kindRequests + listRequests + keyBatches.length} requests, over --max-requests ${opts.maxRequests}`);
  }

  const add = (list: unknown): number => {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const p of list) {
      if (!isPostDto(p)) continue;
      n++;
      if (!seen.has(p.key.toLowerCase())) seen.set(p.key.toLowerCase(), p);
    }
    return n;
  };
  const getList = async (path: string): Promise<unknown[] | null> => {
    const res = await client.get(path);
    if (!Array.isArray(res.body)) {
      failed.push({ path, status: res.status });
      return null;
    }
    return res.body;
  };

  for (const kind of opts.perKind > 0 ? PUBLIC_POST_KINDS : []) {
    perKind[kind] = add(await getList(`/api/Posts/Latest/home/default?postKind=${kind}&count=${opts.perKind}&${V}`));
  }

  const categories: { kind: CategoryKind; key: string }[][] = [];
  const listedKeys = new Map<CategoryKind, Set<string>>();
  for (const kind of opts.perCategory > 0 ? CATEGORY_KINDS : []) {
    const list = (await getList(`/api/${CATEGORY_LIST_PATHS[kind]}?${V}`)) ?? [];
    const keysOfKind = list.flatMap((c) => (c && typeof c === "object" && typeof (c as Json).key === "string" ? [{ kind, key: (c as Json).key as string }] : []));
    listed[kind] = keysOfKind.length;
    listedKeys.set(kind, new Set(keysOfKind.map((c) => c.key.toLowerCase())));
    categories.push(keysOfKind);
  }

  // Take turns across kinds so a cap still leaves some of every kind.
  const ordered: { kind: CategoryKind; key: string }[] = [];
  for (let i = 0; categories.some((c) => i < c.length); i++) for (const c of categories) if (i < c.length) ordered.push(c[i]!);
  const budget = Math.max(0, opts.maxRequests - kindRequests - listRequests - keyBatches.length);
  const chosen = ordered.slice(0, budget);
  const categoriesSkippedByCap = ordered.slice(budget).map((c) => `${c.kind}:${c.key}`);
  const plan = {
    kindRequests,
    listRequests,
    categoryRequests: chosen.length,
    keyRequests: keyBatches.length,
    total: kindRequests + listRequests + chosen.length + keyBatches.length,
    categoriesSkippedByCap,
  };
  log(
    `[import:public] plan: ${plan.total} request(s) in all (${plan.kindRequests} post-kind, ${plan.listRequests} category-list, ${plan.categoryRequests} per-category, ${plan.keyRequests} by-key)` +
      (categoriesSkippedByCap.length ? `; ${categoriesSkippedByCap.length} categor(ies) left out to stay within --max-requests ${opts.maxRequests}` : ""),
  );

  for (const c of chosen) {
    perCategory[`${c.kind}:${c.key}`] = add(await getList(`/api/Posts/Latest/${c.kind}/${encodeURIComponent(c.key)}?count=${opts.perCategory}&${V}`));
  }

  const keysNotFound: string[] = [];
  for (const batch of keyBatches) {
    const list = await getList(`/api/Posts?postKeys=${batch.map(encodeURIComponent).join(",")}&${V}`);
    add(list);
    const found = new Set((list ?? []).filter(isPostDto).map((p) => p.key.toLowerCase()));
    keysNotFound.push(...batch.filter((k) => !found.has(k.toLowerCase())));
  }

  const records: ReleaseRecord[] = [];
  const invalid: FetchedSlice["invalid"] = [];
  const uniqueByKind: Record<string, number> = {};
  const notListedBySource: Record<string, Record<string, number>> = {};
  const field = { ministries: "ministryKeys", sectors: "sectorKeys", themes: "themeKeys", tags: "tagKeys" } as const;
  for (const dto of seen.values()) {
    let mapped: ReleaseRecord;
    try {
      mapped = publicPostToRelease(dto, opts.filesBase);
    } catch (e) {
      invalid.push({ key: dto.key, issue: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const parsed = releaseRecordSchema.safeParse(mapped);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      invalid.push({ key: dto.key, issue: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid" });
      continue;
    }
    records.push(parsed.data);
    uniqueByKind[parsed.data.kind] = (uniqueByKind[parsed.data.kind] ?? 0) + 1;
    for (const [kind, keysListed] of listedKeys) {
      for (const key of new Set(parsed.data[field[kind]])) {
        if (keysListed.has(key.toLowerCase())) continue;
        const m = (notListedBySource[kind] ??= {});
        m[key] = (m[key] ?? 0) + 1;
      }
    }
  }
  return { records, plan, requests: client.requests, perKind, perCategory, listed, failed, keysNotFound, invalid, uniqueByKind, notListedBySource };
}
