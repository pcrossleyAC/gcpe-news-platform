import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { writeOpsLog } from "../settings";
import { csvFilename, mapBatches, oneBatch, streamCsv } from "../reports/csv";
import { bcToday, MAX_RANGE_DAYS, resolveRange, ReportRangeError } from "../reports/range";
import {
  ALL_NEWS, ALL_SUBSCRIBERS, BY_LIST_CSV_HEADER, byListCsvRows, listLabel, MEMBER_CSV_HEADER, memberBatches, memberCsvRow, membersPage,
  ReportListNotFoundError, subscribersByList, TIMING_FILTERS,
} from "../reports/by-list";
import { DIGEST_RUNS_CSV_HEADER, digestRunBatches, digestRunCsvRow, digestRunsPage } from "../reports/digest-runs";
import { RELEASE_SENDS_CSV_HEADER, releaseSendBatches, releaseSendCsvRow, releaseSendsPage } from "../reports/release-sends";
import {
  UNSUBSCRIBE_COUNTS_HEADER, UNSUBSCRIBE_CSV_HEADER, unsubscribeBatches, unsubscribeCsvRow, unsubscribeDailyCounts, unsubscribesPage, unsubscribeWindow,
} from "../reports/unsubscribes";
import { privateErrorsWith } from "./private-errors";
import type { SettingsRouteDeps } from "./routes";
import { NOD_READ_ROLES, NOD_WRITE_ROLES } from "./staff-subscriber-routes";

export type ReportRouteDeps = Pick<SettingsRouteDeps, "timeZone">;

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
export const pageParam = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(10_000).default(1));
const listParam = z.preprocess(
  emptyToUndefined,
  z.string().max(300).default(ALL_SUBSCRIBERS).transform((s) => (s === ALL_SUBSCRIBERS || s === ALL_NEWS ? s : s.toLowerCase())),
);
const membersQuery = z.object({ list: listParam, timing: z.preprocess(emptyToUndefined, z.enum(TIMING_FILTERS).default("any")), page: pageParam });
const dateParam = z.preprocess(emptyToUndefined, z.string().max(10).optional());
export const rangeQuery = z.object({ from: dateParam, to: dateParam, page: pageParam });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ReportRangeError) return void res.status(400).json({ error: e.code, maxDays: MAX_RANGE_DAYS }), true;
  if (e instanceof ReportListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  return false;
}
/** Report queries bind no addresses, but their rows hold them; errors stay label-only. Exported
 * for its own tests (a bare express app, same pattern as staff-subscriber-routes.ts's), which
 * check this error mapping directly rather than hunting for a production route that happens to
 * throw every error this maps. */
export const privateErrors = privateErrorsWith(mapError, "report request");

/** "ministries:health" -> "ministries-health", for a filename. */
function slug(list: string): string {
  if (list === ALL_NEWS) return "all-news";
  return list.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list";
}

/** Spec §8 Reports. Reads: NoD.Viewer and up. Address CSVs: NoD.Editor and NoD.Admin (Q37). */
export function reportRoutes(db: Db, deps: ReportRouteDeps): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const exportAddresses = requireAnyRole(...NOD_WRITE_ROLES);

  const rangeOf = async (req: Request) => {
    const q = rangeQuery.parse(req.query);
    const today = await bcToday(db, deps.timeZone);
    return { range: resolveRange(q, today, deps.timeZone), page: q.page, today };
  };

  r.get("/reports/subscribers-by-list", read, privateErrors(async (_req, res) => {
    res.json(await subscribersByList(db));
  }));

  r.get("/reports/subscribers-by-list.csv", read, privateErrors(async (_req, res) => {
    const report = await subscribersByList(db);
    const today = await bcToday(db, deps.timeZone);
    await streamCsv(res, csvFilename("subscribers-by-list", today), BY_LIST_CSV_HEADER, oneBatch(byListCsvRows(report)));
  }));

  r.get("/reports/subscribers-by-list/members", read, privateErrors(async (req, res) => {
    res.json(await membersPage(db, membersQuery.parse(req.query)));
  }));

  r.get("/reports/subscribers-by-list/members.csv", exportAddresses, privateErrors(async (req, res) => {
    const { list, timing } = membersQuery.parse(req.query);
    await listLabel(db, list); // 404 before any byte of CSV
    const today = await bcToday(db, deps.timeZone);
    await streamCsv(
      res,
      csvFilename(`subscribers-${slug(list)}`, today),
      MEMBER_CSV_HEADER,
      mapBatches(memberBatches(db, list, timing), (m) => memberCsvRow(m, deps.timeZone)),
      // Only once the first batch is in hand -- who took addresses out of the system, and
      // which, never the addresses themselves -- so a query that fails before any row is
      // fetched is never recorded as an export that happened.
      () => writeOpsLog(db, actorOf(req).name, "report-exported", `subscribers ${list} ${timing}`),
    );
  }));

  const pageQuery = z.object({ page: pageParam });

  r.get("/reports/unsubscribes", read, privateErrors(async (req, res) => {
    const { page } = pageQuery.parse(req.query);
    res.json(await unsubscribesPage(db, await unsubscribeWindow(db, deps.timeZone), page));
  }));

  r.get("/reports/unsubscribes/daily.csv", read, privateErrors(async (_req, res) => {
    const window = await unsubscribeWindow(db, deps.timeZone);
    await streamCsv(res, csvFilename("unsubscribe-counts", window.today), UNSUBSCRIBE_COUNTS_HEADER, oneBatch(await unsubscribeDailyCounts(db, window)));
  }));

  r.get("/reports/unsubscribes.csv", exportAddresses, privateErrors(async (req, res) => {
    const window = await unsubscribeWindow(db, deps.timeZone);
    await streamCsv(
      res,
      csvFilename("unsubscribes", window.today),
      UNSUBSCRIBE_CSV_HEADER,
      mapBatches(unsubscribeBatches(db, window), (u) => unsubscribeCsvRow(u, deps.timeZone)),
      () => writeOpsLog(db, actorOf(req).name, "report-exported", "unsubscribes"),
    );
  }));

  r.get("/reports/release-sends", read, privateErrors(async (req, res) => {
    const { range, page } = await rangeOf(req);
    res.json(await releaseSendsPage(db, range, page));
  }));

  r.get("/reports/release-sends.csv", read, privateErrors(async (req, res) => {
    const { range, today } = await rangeOf(req);
    await streamCsv(res, csvFilename("release-sends", today), RELEASE_SENDS_CSV_HEADER, mapBatches(releaseSendBatches(db, range), (s) => releaseSendCsvRow(s, deps.timeZone)));
  }));

  r.get("/reports/digest-runs", read, privateErrors(async (req, res) => {
    const { range, page } = await rangeOf(req);
    res.json(await digestRunsPage(db, range, page));
  }));

  r.get("/reports/digest-runs.csv", read, privateErrors(async (req, res) => {
    const { range, today } = await rangeOf(req);
    await streamCsv(res, csvFilename("digest-runs", today), DIGEST_RUNS_CSV_HEADER, mapBatches(digestRunBatches(db, range), (d) => digestRunCsvRow(d, deps.timeZone)));
  }));

  return r;
}
