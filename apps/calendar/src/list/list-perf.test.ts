import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { seedVolume } from "../../test/volume";
import { seedWorld, type Who, type World } from "../../test/world";
import { loadCalendarActor } from "../actor";
import type { ApiDeps } from "../http/routes";
import { listPage } from "./page";

/** Spec addendum §3 row 5d: the list query under 500 ms on 50,000 activities. Opt-in: run with
 * `CALENDAR_PERF=1 npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/list-perf.test.ts`
 * so a plain `vitest run` (and CI) skips the 50k-row fixture build. */
const BUDGET_MS = 500;
const RUNS = 10;
const SHAPES: { name: string; who: Who; q: ListQueryInput; offset?: number; expectEmpty?: boolean }[] = [
  { name: "a ministry editor's default list, first page", who: "editor", q: {} },
  { name: "a ministry editor's default list, tenth page", who: "editor", q: {}, offset: 270 },
  { name: "HQ, every year since 2011, by title descending, offset 1,500", who: "hqEditor", q: { filter: { from: "2011-01-01" }, sort: "title", dir: "desc" }, offset: 1500 },
  { name: "HQ Administrator, every year, by categories, offset 900", who: "hqAdmin", q: { filter: { from: "2011-01-01" }, sort: "categories" }, offset: 900 },
  // By design this term matches none of the fixture's text (hex-only md5 content): the point is the
  // cost of the full-text predicate over 50,000 rows with no index to shortcut an empty result.
  { name: "HQ, a quick search that matches nothing, every year", who: "hqEditor", q: { filter: { from: "2011-01-01", quickSearch: "zzqx none" } }, expectEmpty: true },
  // "health" is excluded from this check deliberately: seedVolume's health activities are always
  // the even g's (g % 30 === 0), and its keywords are only ever assigned to odd g's, so a
  // health + keywordIds filter is structurally empty regardless of the query. "finance" (g % 30 ===
  // 1, always odd) is the same shape of filter against rows that can actually carry a keyword.
  { name: "HQ, three HQ Tags and a Lead Ministry, every year", who: "hqEditor", q: { filter: { from: "2011-01-01", keywordIds: [1001, 1002, 1003], ministryKey: "finance" } } },
  { name: "HQ Advanced, a corporate query, show all", who: "hqAdvanced", q: { corporate: { days: null, statuses: ["new", "changed", "la_new"] } } },
  { name: "a ministry editor's watchlist, every year", who: "editor", q: { display: "my_watchlist", filter: { from: "2011-01-01" } } },
];

describe.skipIf(!process.env.CALENDAR_PERF)("the list on 50,000 activities", () => {
  let tdb: TestDatabase;
  let w: World;
  let deps: ApiDeps;
  const results: { name: string; p95: number; max: number; total: number }[] = [];

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    w = await seedWorld(createTestApp(tdb.db), tdb.db);
    await seedVolume(tdb.db, 50_000);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
  }, 180_000);
  afterAll(async () => {
    // The measured table, for the performance record.
    console.info(results.map((r) => `${r.p95.toFixed(0).padStart(5)} ms p95 ${r.max.toFixed(0).padStart(5)} ms max ${String(r.total).padStart(6)} rows  ${r.name}`).join("\n"));
    await tdb.drop();
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: p95 of ${RUNS} runs under ${BUDGET_MS} ms`, async () => {
      const actor = (await loadCalendarActor(tdb.db, w.as[shape.who].id))!;
      const q = listQuerySchema.parse(shape.q);
      const first = await listPage(deps, actor, q, shape.offset ?? 0);
      const times: number[] = [];
      for (let n = 0; n < RUNS; n++) {
        const t0 = performance.now();
        await listPage(deps, actor, q, shape.offset ?? 0);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(0.95 * RUNS) - 1]!;
      results.push({ name: shape.name, p95, max: times[RUNS - 1]!, total: first.total });
      if (shape.expectEmpty) expect(first.total).toBe(0);
      else expect(first.total).toBeGreaterThan(0);
      expect(p95).toBeLessThan(BUDGET_MS);
    }, 60_000);
  }
});
