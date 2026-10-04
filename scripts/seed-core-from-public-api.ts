#!/usr/bin/env -S node --
// Seeds Core's ministries (organizations) and sector/theme/tag terms on a deployed stack from
// the public, read-only BC Gov News API (https://api.news.gov.bc.ca). Thin CLI: all fetching
// and mapping logic lives in scripts/lib/public-taxonomy.ts, which is unit-tested separately
// (tests/seed-core-from-public-api.test.ts).
//
// Usage:
//   GCPE_TOKEN=<admin bearer token> npx -y -p node@24 -- node node_modules/tsx/dist/cli.mjs \
//     scripts/seed-core-from-public-api.ts https://boxs.ca
// or:
//   GCPE_TOKEN=<admin bearer token> npm run core:seed-from-public-api -- https://boxs.ca
//
// The bearer token is read ONLY from the GCPE_TOKEN environment variable -- never from argv,
// never logged. Bearer requests don't need the session CSRF header (packages/auth/src/bearer.ts
// only enforces that header on the cookie-session fallback path).
import { pathToFileURL } from "node:url";
import type { TermKind } from "@gcpe/events";
import { orgInputSchema } from "../apps/core/src/services/organizations";
import { termInputSchema } from "../apps/core/src/services/terms";
import {
  DEFAULT_PUBLIC_API_BASE,
  fetchMinister,
  fetchMinistries,
  fetchSectors,
  fetchTags,
  fetchThemes,
  sleep,
  toOrgInput,
  toTermInput,
  type PublicCategory,
} from "./lib/public-taxonomy";

/** Polite default delay between sequential GETs/PUTs against either API. */
const DEFAULT_DELAY_MS = 200;

interface Failure {
  key: string;
  status: number;
}

interface KindSummary {
  kind: string;
  upserted: number;
  failed: number;
  failures: Failure[];
}

export interface RunOptions {
  /** Base URL of the deployed stack whose Core admin API we write to (e.g. https://boxs.ca). */
  targetBaseUrl: string;
  /** Bearer token for Core's admin API. Caller must have read this from GCPE_TOKEN -- this
   * function never reads env vars itself, so it can't accidentally source a token elsewhere. */
  token: string;
  /** Base URL of the public source API. Defaults to the real public API; overridable for tests. */
  publicApiBase?: string;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  summaries: KindSummary[];
  republishOk: boolean;
}

function authHeaders(token: string): Record<string, string> {
  // Bearer header only -- never a query string or URL parameter, so the token can't end up in
  // logs, proxies' access logs, or shell history via a printed URL.
  return { authorization: `Bearer ${token}` };
}

async function putJson(baseUrl: string, path: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(new URL(path, baseUrl), {
    method: "PUT",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postNoBody(baseUrl: string, path: string, token: string, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(new URL(path, baseUrl), { method: "POST", headers: authHeaders(token) });
}

async function seedMinistries(opts: Required<Pick<RunOptions, "targetBaseUrl" | "token" | "publicApiBase" | "delayMs" | "fetchImpl">>): Promise<KindSummary> {
  const { targetBaseUrl, token, publicApiBase, delayMs, fetchImpl } = opts;
  const summary: KindSummary = { kind: "ministries", upserted: 0, failed: 0, failures: [] };
  const ministries = await fetchMinistries(publicApiBase, fetchImpl);
  for (const ministry of ministries) {
    await sleep(delayMs);
    const minister = await fetchMinister(publicApiBase, ministry.key, fetchImpl);
    const input = orgInputSchema.parse(toOrgInput(ministry, minister));
    await sleep(delayMs);
    const res = await putJson(targetBaseUrl, `/core/api/organizations/${encodeURIComponent(input.key)}`, token, input, fetchImpl);
    if (res.ok) summary.upserted++;
    else {
      summary.failed++;
      summary.failures.push({ key: input.key, status: res.status });
    }
  }
  return summary;
}

async function seedTermKind(
  kind: TermKind,
  fetcher: (baseUrl: string, fetchImpl: typeof fetch) => Promise<PublicCategory[]>,
  opts: Required<Pick<RunOptions, "targetBaseUrl" | "token" | "publicApiBase" | "delayMs" | "fetchImpl">>,
): Promise<KindSummary> {
  const { targetBaseUrl, token, publicApiBase, delayMs, fetchImpl } = opts;
  const summary: KindSummary = { kind, upserted: 0, failed: 0, failures: [] };
  const categories = await fetcher(publicApiBase, fetchImpl);
  for (const category of categories) {
    const input = termInputSchema.parse(toTermInput(kind, category));
    await sleep(delayMs);
    const res = await putJson(targetBaseUrl, `/core/api/terms/${kind}/${encodeURIComponent(input.key)}`, token, input, fetchImpl);
    if (res.ok) summary.upserted++;
    else {
      summary.failed++;
      summary.failures.push({ key: input.key, status: res.status });
    }
  }
  return summary;
}

/**
 * Runs the full seed: ministries, then sectors/themes/tags, then (always, so whatever did land
 * reaches subscribers) a republish. Returns non-ok if any upsert or the republish itself failed.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.log(line));
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const publicApiBase = opts.publicApiBase ?? DEFAULT_PUBLIC_API_BASE;
  const common = { targetBaseUrl: opts.targetBaseUrl, token: opts.token, publicApiBase, delayMs, fetchImpl };

  const summaries: KindSummary[] = [];
  summaries.push(await seedMinistries(common));
  summaries.push(await seedTermKind("sector", fetchSectors, common));
  summaries.push(await seedTermKind("theme", fetchThemes, common));
  summaries.push(await seedTermKind("tag", fetchTags, common));

  for (const s of summaries) {
    log(`${s.kind}: upserted=${s.upserted} failed=${s.failed}`);
    for (const f of s.failures) log(`  FAILED ${s.kind} key=${f.key} status=${f.status}`);
  }

  // Always republish last, even if some upserts failed, so subscribers get whatever did land.
  const republishRes = await postNoBody(opts.targetBaseUrl, "/core/api/admin/republish", opts.token, fetchImpl);
  log(republishRes.ok ? "republish: ok" : `republish: FAILED status=${republishRes.status}`);

  const anyUpsertFailed = summaries.some((s) => s.failed > 0);
  return { ok: !anyUpsertFailed && republishRes.ok, summaries, republishOk: republishRes.ok };
}

function readToken(env: NodeJS.ProcessEnv): string {
  const token = env.GCPE_TOKEN;
  if (!token) throw new Error("GCPE_TOKEN environment variable is required (the token is never read from argv)");
  return token;
}

async function main(): Promise<void> {
  const targetBaseUrl = process.argv[2];
  if (!targetBaseUrl) {
    console.error("usage: seed-core-from-public-api.ts <deployed-stack-base-url>");
    process.exitCode = 1;
    return;
  }
  const token = readToken(process.env);
  const { ok } = await run({ targetBaseUrl, token });
  process.exitCode = ok ? 0 : 1;
}

// Only run main() when this file is the actual entry point, not when a test imports run()/etc.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[seed-core-from-public-api]", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
