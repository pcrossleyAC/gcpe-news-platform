import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bcDateSchema, type CalendarRules } from "@gcpe/calendar-contract";
import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import type { ObjectStore } from "@gcpe/storage";
import { applyCalendarUsers, planCalendarUsers } from "../../../core/src/import/calendar-users";
import { loadLegacyKeys, type LegacyKeys } from "../../../core/src/import/legacy-keys";
import { commContactLabel } from "../activities/history";
import { applyActivities, applyCommContacts, applyLookups, rebaseSequences } from "./apply";
import { applyFavourites, applyFiles, applyHistory, applyProfiles, applySavedFilters } from "./apply-related";
import { mapHistory, type HistoryContext } from "./history-map";
import type { LegacySnapshot, OptionalTable } from "./legacy-rows";
import { loadLegacy } from "./load";
import { favouritesByActivity, joinsByActivity, mapActivity, unknownLegacyKeys, userCandidates, validationProblems, type MappedActivity } from "./map";
import { CalendarImportReport } from "./report";
import { selectScope, type Scope } from "./scope";

/** Its own key in the "gcpe" two-int lock space (nrms:import uses 2). */
export const CALENDAR_IMPORT_LOCK = [0x67637065, 3] as const;
/** Stands in for a user the dry run would create: nothing is written, so it never lands anywhere. */
const PLANNED_USER = "00000000-0000-4000-8000-000000000000";

export class ImportAlreadyRunningError extends Error { constructor() { super("another calendar:import is already running"); } }
export class UnknownLegacyKeysError extends Error {
  override name = "UnknownLegacyKeysError";
  constructor(n: number) { super(`${n} legacy key(s) aren't in Core; fix Core first (listed in the report)`); }
}
/** A bad command line: its message is ours, safe to print as it is. */
export class ImportArgumentError extends Error { override name = "ImportArgumentError"; }
export class ImportStageError extends Error {
  constructor(readonly stage: string, readonly report: CalendarImportReport, cause: unknown) {
    const label = safeErrorLabel(cause);
    super(`calendar:import failed during ${stage}: ${label}`);
    report.markFailed(stage, label);
  }
}

interface CalendarImportBase { db: Db; coreDb: Db; store: ObjectStore; rules: CalendarRules; coreSubscribers: SubscriberConfig[]; log?: (s: string) => void }
/** The legacy rows come from SQL Server, or from a snapshot already read (the CSV export the report parity check uses). */
export type CalendarImportDeps = CalendarImportBase & ({ source: LegacySource; snapshot?: undefined } | { snapshot: LegacySnapshot; source?: undefined });
export interface CalendarImportOptions { cutoff: string; confirm: boolean }

export function parseImportArgs(argv: string[]): { cutoff: string; confirm: boolean; reportPath?: string } {
  let cutoff: string | undefined;
  let confirm = false;
  let reportPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cutoff") cutoff = argv[++i];
    else if (a === "--confirm") confirm = true;
    else if (a === "--report") reportPath = argv[++i];
    else throw new ImportArgumentError(`Unknown argument: ${a}`);
  }
  if (!cutoff) throw new ImportArgumentError("--cutoff <YYYY-MM-DD> is required: the date activities must end on or after (Q53)");
  if (!bcDateSchema.safeParse(cutoff).success) throw new ImportArgumentError("--cutoff must be a real date, YYYY-MM-DD");
  return reportPath ? { cutoff, confirm, reportPath } : { cutoff, confirm };
}

export function historyContextOf(s: LegacySnapshot, scope: Scope, keys: LegacyKeys, userIdOf: (id: number | null) => string | null, mapped: Map<number, MappedActivity>, timeZone: string): HistoryContext {
  const userName = (id: number | null) => { const u = id === null ? undefined : s.users.find((x) => x.Id === id); return u ? (u.DisplayName ?? u.FullName) : null; };
  return {
    timeZone, userIdOf,
    actorNameOf: userName,
    cityNameOf: (id) => s.lookups.cities.find((c) => c.Id === id)?.Name ?? null,
    commContactLabelOf: (id) => { const c = s.commContacts.find((x) => x.Id === id); return c ? commContactLabel(userName(c.SystemUserId), c.MinistryId ? (keys.org(c.MinistryId)?.abbreviation ?? null) : null) : null; },
    orgNameOf: (g) => keys.org(g)?.displayName ?? null,
    contactMinistryKeyOf: (id) => mapped.get(id)?.values.contactMinistryKey ?? null,
  };
}

const REPORT_TABLE: Record<OptionalTable, string> = { users: "users", userMinistries: "userMinistries", savedFilters: "savedFilters", favourites: "favourites", files: "files", logs: "logRows" };

function balanceScope(report: CalendarImportReport, s: LegacySnapshot, scope: Scope) {
  report.legacy("activities", s.totals.activities); report.count("activities", "outOfScope", scope.outOfScope.activities);
  report.legacy("users", s.users.length); report.count("users", "outOfScope", s.users.length - scope.userIds.size);
  report.legacy("commContacts", s.commContacts.length); report.count("commContacts", "outOfScope", s.commContacts.length - scope.commContacts.length);
  report.legacy("savedFilters", s.savedFilters.length); report.count("savedFilters", "outOfScope", s.savedFilters.length - scope.savedFilters.length);
  report.legacy("favourites", s.totals.favourites); report.count("favourites", "outOfScope", scope.outOfScope.favourites);
  report.legacy("files", s.totals.files); report.count("files", "outOfScope", scope.outOfScope.files);
  report.legacy("logRows", s.totals.logs); report.count("logRows", "outOfScope", scope.outOfScope.logs);
  report.fact("releaseLinksInScope", scope.outOfScope.releaseLinksInScope);
  report.fact("releaseLinksOutOfScope", scope.outOfScope.releaseLinks);
  for (const t of s.provenance?.notProvided ?? []) report.notProvided(REPORT_TABLE[t], "not in the snapshot");
  for (const n of s.provenance?.notes ?? []) report.note(n);
}

function recordFacts(report: CalendarImportReport, s: LegacySnapshot, scope: Scope, imported: MappedActivity[], invalidEmails: number, duplicateGroups: number, history: { activityId: number; logIds: number[] }[], awarenessIds: readonly number[]) {
  const missing = new Set(s.provenance?.notProvided ?? []);
  const usersAreReal = !missing.has("users") && s.provenance?.usersFromCommContacts !== true;
  report.fact("activityIdMin", imported.length ? Math.min(...imported.map((m) => m.id)) : 0);
  report.fact("activityIdMax", imported.length ? Math.max(...imported.map((m) => m.id)) : 0);
  if (usersAreReal) {
    const selectedUsers = s.users.filter((u) => scope.userIds.has(u.Id));
    report.fact("usersWithoutEmail", selectedUsers.filter((u) => (u.EmailAddress ?? "").trim() === "").length + invalidEmails);
    report.fact("usersWithInvalidEmail", invalidEmails);
    report.fact("duplicateEmailGroups", duplicateGroups);
    const inactive = new Set(s.users.filter((u) => u.IsActive !== true).map((u) => u.Id));
    report.fact("commContactsOfInactiveUsers", scope.commContacts.filter((c) => inactive.has(c.SystemUserId)).length);
  }
  report.fact("awarenessNotDeleted", imported.filter((m) => m.values.deletedAt === null && m.joins.categoryIds.some((c) => awarenessIds.includes(c))).length);
  report.fact("activitiesWithTwoOrMoreCategories", imported.filter((m) => m.joins.categoryIds.length >= 2).length);
  if (!missing.has("logs")) {
    const perActivity = new Map<number, number>();
    for (const h of history) perActivity.set(h.activityId, (perActivity.get(h.activityId) ?? 0) + h.logIds.length);
    report.fact("historyRows", [...perActivity.values()].reduce((a, b) => a + b, 0));
    report.fact("historyRowsMostOnOneActivity", Math.max(0, ...perActivity.values()));
  }
}

export async function runCalendarImport(deps: CalendarImportDeps, opts: CalendarImportOptions): Promise<CalendarImportReport> {
  const report = new CalendarImportReport(opts.confirm ? "confirmed" : "dry-run", opts.cutoff);
  const scopeOpts = { cutoff: opts.cutoff, awarenessCategoryIds: deps.rules.awarenessCategoryIds };
  const tz = deps.rules.timeZone;
  let stage = "read";
  const body = async () => {
    try {
      const s = deps.snapshot !== undefined ? deps.snapshot : await loadLegacy(deps.source, scopeOpts);
      const scope = selectScope(s, scopeOpts);
      balanceScope(report, s, scope);
      stage = "keys";
      const keys = await loadLegacyKeys(deps.coreDb);
      const unknown = unknownLegacyKeys(s, scope, keys);
      if (unknown.length) { report.unknownKeys(unknown); throw new UnknownLegacyKeysError(unknown.length); }
      stage = "users";
      const plan = await planCalendarUsers(deps.coreDb, userCandidates(s, scope, keys));
      const duplicateGroups = plan.groups.filter((g) => g.legacyIds.length > 1).length;
      for (const g of plan.groups) if (g.legacyIds.length > 1) report.note(`legacy users ${g.legacyIds.join(", ")} share an email and map to one Core user`);
      for (const id of plan.invalidEmails) report.note(`legacy user ${id}'s email isn't valid; imported with none (inactive)`);
      const joins = joinsByActivity(scope);
      const keywordName = (id: number) => s.lookups.keywords.find((k) => k.Id === id)?.Name ?? "";

      if (!opts.confirm) {
        report.count("users", "planned", scope.userIds.size);
        const userIdOf = (id: number | null) => { if (id === null || !scope.userIds.has(id)) return null; return plan.groups.find((g) => g.legacyIds.includes(id))?.existingUserId ?? PLANNED_USER; };
        const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: tz, userIdOf, commContactIdOf: (id) => id, keys }));
        const ok = mapped.filter((m): m is MappedActivity => !("skip" in m));
        for (const m of mapped) if ("skip" in m) report.skip("activities", String(m.id), m.skip);
        for (const m of ok) report.warn(m.id, validationProblems(m, m.joins.keywordIds.map(keywordName), deps.rules));
        for (const m of ok) report.mapping(m.id, m.notes);
        report.count("activities", "planned", ok.length);
        for (const t of ["commContacts", "savedFilters", "favourites", "files", "logRows"] as const) {
          const n = { commContacts: scope.commContacts.length, savedFilters: scope.savedFilters.length, favourites: scope.favourites.length, files: scope.files.length, logRows: scope.logs.length }[t];
          report.count(t, "planned", n);
        }
        const h = mapHistory(scope.logs, historyContextOf(s, scope, keys, userIdOf, new Map(ok.map((m) => [m.id, m])), tz));
        recordFacts(report, s, scope, ok, plan.invalidEmails.length, duplicateGroups, h.entries, deps.rules.awarenessCategoryIds);
        return report;
      }

      const users = await applyCalendarUsers(deps.coreDb, plan, deps.coreSubscribers);
      const changedByEmail = new Set([...users.activated, ...users.accessGranted]);
      const emailGroups = plan.groups.filter((g) => g.how === "email");
      report.count("users", "inserted", plan.groups.filter((g) => g.how === "new").reduce((n, g) => n + g.legacyIds.length, 0));
      report.count("users", "updated", emailGroups.filter((g) => changedByEmail.has(g.existingUserId!)).reduce((n, g) => n + g.legacyIds.length, 0));
      report.count("users", "unchanged",
        plan.groups.filter((g) => g.how === "legacy-id").reduce((n, g) => n + g.legacyIds.length, 0)
        + emailGroups.filter((g) => !changedByEmail.has(g.existingUserId!)).reduce((n, g) => n + g.legacyIds.length, 0));
      for (const g of users.groups) if (g.legacyIds.length > 1) report.note(`legacy users ${g.legacyIds.join(", ")} merged into Core user ${g.userId}`);
      const accessKept = new Set(users.accessKept);
      const activated = new Set(users.activated);
      for (const g of users.groups) {
        if (accessKept.has(g.userId)) report.userAccessKept(g.legacyIds, g.userId);
        if (activated.has(g.userId)) report.userActivated(g.legacyIds, g.userId);
      }
      const userIdOf = (id: number | null) => (id === null ? null : (users.userIdOf.get(id) ?? null));
      stage = "lookups"; await applyLookups(deps.db, s, report);
      stage = "commContacts"; const remap = await applyCommContacts(deps.db, scope, (id) => userIdOf(id), keys, report);
      stage = "activities";
      const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: tz, userIdOf, commContactIdOf: (id) => (id === null ? null : (remap.get(id) ?? null)), keys }));
      for (const m of mapped) if ("skip" in m) report.skip("activities", String(m.id), m.skip);
      const ok = mapped.filter((m): m is MappedActivity => !("skip" in m));
      for (const m of ok) report.warn(m.id, validationProblems(m, m.joins.keywordIds.map(keywordName), deps.rules));
      for (const m of ok) report.mapping(m.id, m.notes);
      const { inserted, present } = await applyActivities(deps.db, ok, favouritesByActivity(scope), (id) => userIdOf(id), report);
      stage = "favourites"; await applyFavourites(deps.db, scope, (id) => userIdOf(id), present, inserted, report);
      stage = "profiles"; await applyProfiles(deps.db, s, users.groups, report);
      stage = "savedFilters"; await applySavedFilters(deps.db, scope, (id) => userIdOf(id), keys, report);
      stage = "files"; await applyFiles(deps.db, deps.store, scope, (id) => userIdOf(id), present, tz, report);
      stage = "history";
      const h = mapHistory(scope.logs, historyContextOf(s, scope, keys, userIdOf, new Map(ok.map((m) => [m.id, m])), tz));
      await applyHistory(deps.db, h.entries, h.skipped, present, report);
      stage = "sequences"; await rebaseSequences(deps.db);
      recordFacts(report, s, scope, ok, plan.invalidEmails.length, duplicateGroups, h.entries, deps.rules.awarenessCategoryIds);
      return report;
    } catch (e) {
      // Unknown keys included: stage is "keys", the report already lists them, and the CLI writes it.
      throw new ImportStageError(stage, report, e);
    }
  };
  return opts.confirm ? withAdvisoryLock(deps.db, CALENDAR_IMPORT_LOCK, () => new ImportAlreadyRunningError(), body) : body();
}

const textPath = (p: string) => (p.endsWith(".json") ? `${p.slice(0, -5)}.txt` : `${p}.txt`);
/** `apps/calendar/import-reports/`, git-ignored: never the npm workspace's own working directory. */
const DEFAULT_REPORT_DIR = fileURLToPath(new URL("../../import-reports", import.meta.url));
export function defaultReportPath(now = new Date()): string {
  return join(DEFAULT_REPORT_DIR, `calendar-import-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
}
async function writeReport(report: CalendarImportReport, path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report.toJSON(), null, 2));
  await writeFile(textPath(path), report.toText());
}

/** Runs, writes the report (a partial one on failure), and returns 0 balanced, 2 not balanced, 1 on any error. */
export async function runCalendarImportCli(deps: CalendarImportDeps & { reportPath: string }, opts: CalendarImportOptions): Promise<0 | 1 | 2> {
  const log = deps.log ?? (() => {});
  try {
    const report = await runCalendarImport(deps, opts);
    await writeReport(report, deps.reportPath);
    log(report.toText());
    return report.balanced() ? 0 : 2;
  } catch (e) {
    const report = e instanceof ImportStageError ? e.report : null;
    if (report) await writeReport(report, deps.reportPath);
    log(e instanceof Error ? e.message : safeErrorLabel(e));
    return 1;
  }
}
