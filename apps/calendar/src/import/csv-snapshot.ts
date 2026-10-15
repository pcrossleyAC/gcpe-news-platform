import {
  JOIN_TABLES, LOOKUP_TABLES, type JoinTable, type LegacyActivity, type LegacyCommContact, type LegacyJoinRow, type LegacyLookup,
  type LegacyReleaseLink, type LegacySnapshot, type LegacyUser, type LookupTable, type OptionalTable,
} from "./legacy-rows";
import { NEEDS_REVIEW_COLUMNS } from "./map";

// Survey 08's Part B export (docs/parity/legacy-survey/08-calendar-parity.sql, v2), saved from SSMS
// as CSV: every record starts with its query label, each result set has its own "query,…" header,
// NULL is the literal text NULL, and dates are ISO text. Only the report parity check reads it.

export interface CsvFile { name: string; bytes: Uint8Array }
export type CsvEncoding = "utf-8" | "windows-1252";
type CsvRow = Record<string, string | null>;
interface CsvSection { label: string; file: string; rows: CsvRow[] }
/** Its message names a file, a section, a row and a column, never a cell's value: it reaches the terminal. */
export class CsvSnapshotError extends Error { override name = "CsvSnapshotError"; }

/** UTF-8 when the bytes are valid UTF-8 (a BOM is dropped), else Windows-1252, SSMS's ANSI default here. */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** RFC 4180: a field that starts with a quote runs to its closing quote, "" inside is one quote, and CRLF or LF ends a record. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (c === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (c === ",") { row.push(field); field = ""; atStart = true; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; atStart = true;
      continue;
    }
    field += c;
    atStart = false;
  }
  if (quoted) throw new CsvSnapshotError("a quoted field never closes");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** "8.2" and "8.20" are one label: the export drops a trailing zero. */
export function sectionLabel(raw: string): string | null {
  const m = /^(\d+)\.(\d{1,2})$/.exec(raw.trim());
  return m ? `${m[1]}.${m[2]!.padEnd(2, "0")}` : null;
}

const LOOKUP_BASE = ["Id", "Name", "SortOrder", "IsActive"];
const JOIN_SECTION: Record<JoinTable, { label: string; column: string; guid: boolean }> = {
  categories: { label: "8.11", column: "CategoryId", guid: false },
  commMaterials: { label: "8.12", column: "CommunicationMaterialId", guid: false },
  initiatives: { label: "8.13", column: "InitiativeId", guid: false },
  keywords: { label: "8.14", column: "KeywordId", guid: false },
  nrOrigins: { label: "8.15", column: "NROriginId", guid: false },
  sectors: { label: "8.16", column: "SectorId", guid: true },
  sharedWith: { label: "8.17", column: "MinistryId", guid: true },
  tags: { label: "8.18", column: "TagId", guid: true },
  themes: { label: "8.19", column: "ThemeId", guid: true },
};
const LOOKUP_SECTION: Record<LookupTable, { label: string; extra: string[] }> = {
  categories: { label: "8.30", extra: [] }, cities: { label: "8.31", extra: [] }, commMaterials: { label: "8.33", extra: [] },
  eventPlanners: { label: "8.34", extra: ["PhoneNumber", "JobTitle"] }, governmentRepresentatives: { label: "8.35", extra: ["Description"] },
  initiatives: { label: "8.36", extra: ["ShortName"] }, keywords: { label: "8.37", extra: [] }, nrDistributions: { label: "8.38", extra: [] },
  nrOrigins: { label: "8.39", extra: [] }, premierRequested: { label: "8.40", extra: [] }, videographers: { label: "8.42", extra: ["JobTitle"] },
};
const ACTIVITY_COLUMNS = [
  "Id", "StartDateTime", "EndDateTime", "PotentialDates", "NRDateTime", "IsAllDay", "IsConfirmed", "Title", "Details", "Schedule", "Significance",
  "Strategy", "Comments", "HqComments", "LeadOrganization", "Venue", "Translations", "OtherCity", "StatusId", "HqStatusId", "HqSection",
  "NRDistributionId", "PremierRequestedId", "ContactMinistryId", "GovernmentRepresentativeId", "CommunicationContactId", "EventPlannerId",
  "VideographerId", "CityId", "IsActive", "IsIssue", "IsAtLegislature", "IsConfidential", "IsCrossGovernment", "IsMilestone",
  "CreatedDateTime", "CreatedBy", "LastUpdatedDateTime", "LastUpdatedBy",
];
/** The columns each known section must carry. Any other label is ignored. */
const SECTION_COLUMNS: Record<string, string[]> = {
  "8.10": ACTIVITY_COLUMNS,
  ...Object.fromEntries(Object.values(JOIN_SECTION).map((j) => [j.label, ["ActivityId", j.column, "IsActive"]])),
  "8.20": ["ActivityId"],
  ...Object.fromEntries(Object.values(LOOKUP_SECTION).map((l) => [l.label, [...LOOKUP_BASE, ...l.extra]])),
  "8.32": ["Id", "SystemUserId", "Name", "MinistryId", "SortOrder", "IsActive"],
  "8.43": ["Id", "Key", "DisplayName", "Abbreviation", "IsActive"],
  "8.44": ["Id", "Key", "DisplayName", "IsActive"],
  "8.45": ["Id", "Key", "DisplayName", "IsActive"],
  "8.46": ["Id", "Key", "DisplayName", "SortOrder", "IsActive"],
};

const blank = (cells: string[]) => cells.every((c) => c.trim() === "");

function readSections(files: readonly CsvFile[]) {
  const sections = new Map<string, CsvSection>();
  const encodings: Record<string, CsvEncoding> = {};
  const ignored = new Set<string>();
  for (const f of files) {
    const { text, encoding } = decodeCsv(f.bytes);
    encodings[f.name] = encoding;
    let header: string[] | null = null;
    let current: CsvSection | null = null;
    let record = 0;
    for (const cells of parseCsv(text)) {
      record++;
      if (blank(cells)) continue;
      if (cells[0] === "query") {
        const width = cells.length - [...cells].reverse().findIndex((c) => c.trim() !== "");
        header = cells.slice(0, width);
        current = null;
        continue;
      }
      const label = sectionLabel(cells[0]!);
      if (!header || !label) throw new CsvSnapshotError(`${f.name}: record ${record} has no query label under a "query,…" header`);
      if (!current || current.label !== label) {
        const need = SECTION_COLUMNS[label];
        if (!need) { ignored.add(label); current = { label, file: f.name, rows: [] }; continue; }
        // The header first: survey 08's Part A labels (8.1, 8.2, 8.3) read as 8.10, 8.20, 8.30 and must be named as the wrong file.
        const lacking = need.find((c) => !header!.includes(c));
        if (lacking) throw new CsvSnapshotError(`${f.name}: section ${label}'s header lacks ${lacking}`);
        const prior = sections.get(label);
        if (prior) throw new CsvSnapshotError(`section ${label} appears twice (${prior.file} and ${f.name})`);
        current = { label, file: f.name, rows: [] };
        sections.set(label, current);
      }
      if (!SECTION_COLUMNS[label]) continue;
      if (cells.length < header.length || !blank(cells.slice(header.length))) {
        throw new CsvSnapshotError(`${f.name}: section ${label}, row ${current.rows.length + 1}: ${cells.length} cells for ${header.length} columns`);
      }
      const row: CsvRow = {};
      header.forEach((h, i) => { if (h !== "") row[h] = cells[i] === "NULL" ? null : cells[i]!; });
      current.rows.push(row);
    }
  }
  return { sections, encodings, ignored: [...ignored].sort() };
}

function readPartC(file: CsvFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const cells of parseCsv(decodeCsv(file.bytes).text)) {
    if (blank(cells) || cells[0] === "query") continue;
    const label = sectionLabel(cells[0]!);
    const n = Number(cells[1]);
    if (!label || !Number.isSafeInteger(n) || n < 0) throw new CsvSnapshotError(`${file.name}: a Part C record isn't "label,count"`);
    out.set(label, n);
  }
  return out;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

/** Typed reads of one row; every error names the place only. */
function cellsOf(s: CsvSection, i: number) {
  const r = s.rows[i]!;
  const fail = (col: string, what: string): never => { throw new CsvSnapshotError(`${s.file}: section ${s.label}, row ${i + 1}, column ${col}: ${what}`); };
  const int = (col: string): number | null => {
    const v = r[col] ?? null;
    if (v === null || v === "") return null;
    return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : fail(col, "not a whole number");
  };
  const bool = (col: string): boolean | null => {
    const v = r[col] ?? null;
    if (v === null || v === "") return null;
    const t = v.toLowerCase();
    return t === "1" || t === "true" ? true : t === "0" || t === "false" ? false : fail(col, "not 0 or 1");
  };
  return {
    text: (col: string) => r[col] ?? "",
    str: (col: string) => r[col] ?? null,
    int,
    reqInt: (col: string) => int(col) ?? fail(col, "is empty"),
    bool,
    reqBool: (col: string) => bool(col) ?? fail(col, "is empty"),
    guid: (col: string) => { const v = r[col] ?? null; return v === null || GUID.test(v) ? v : fail(col, "not a GUID"); },
    reqGuid: (col: string) => { const v = r[col] ?? null; return v !== null && GUID.test(v) ? v : fail(col, "not a GUID"); },
    reqText: (col: string) => { const v = r[col] ?? ""; return v.trim() !== "" ? v : fail(col, "is empty"); },
    /** Legacy DATETIMEs: BC wall-clock time in the UTC fields, as load.ts receives them from mssql. */
    wall: (col: string): Date | null => {
      const v = r[col] ?? null;
      if (v === null || v === "") return null;
      const m = WALL.exec(v);
      if (!m) return fail(col, "not a date and time");
      const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      const ms = Number((m[7] ?? "0").padEnd(3, "0").slice(0, 3));
      const at = new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms));
      return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d && h < 24 && mi < 60 && se < 60 ? at : fail(col, "not a date and time");
    },
  };
}
const rowsOf = <T>(s: CsvSection, f: (c: ReturnType<typeof cellsOf>) => T): T[] => s.rows.map((_, i) => f(cellsOf(s, i)));

export interface LegacyKeyRow { Id: string; Key: string; DisplayName: string; Abbreviation: string | null; SortOrder: number | null; IsActive: boolean }
/** dbo.Ministry, Sector, Theme and Tag (8.43–8.46): what a throwaway Core needs so the importer's key check passes. */
export interface LegacyKeyRows { ministries: LegacyKeyRow[]; sectors: LegacyKeyRow[]; themes: LegacyKeyRow[]; tags: LegacyKeyRow[] }
export interface CsvSnapshot { snapshot: LegacySnapshot; keys: LegacyKeyRows; encodings: Record<string, CsvEncoding>; ignoredSections: string[] }
export interface CsvSnapshotOptions {
  /** Part C's row counts: enforced for every section it lists, and the only way a section may be absent (a count of 0). */
  partC?: CsvFile | undefined;
  /** Make users from comm contacts, so contacts import and their names reach the reports. */
  usersFromCommContacts: boolean;
}

/** The same LegacySnapshot load.ts builds from SQL Server, from survey 08's Part B CSV files. */
export function snapshotFromCsv(files: readonly CsvFile[], o: CsvSnapshotOptions): CsvSnapshot {
  const { sections, encodings, ignored } = readSections(files);
  const partC = o.partC ? readPartC(o.partC) : null;
  for (const [label, expected] of partC ?? []) {
    const got = sections.get(label)?.rows.length ?? 0;
    if (got !== expected) throw new CsvSnapshotError(`section ${label}: ${got} rows read, Part C says ${expected}`);
  }
  const need = (label: string): CsvSection => {
    const s = sections.get(label);
    if (s) return s;
    if (partC?.get(label) === 0) return { label, file: "(Part C: no rows)", rows: [] };
    throw new CsvSnapshotError(`section ${label} is missing${partC ? "" : " (pass the Part C counts if it is truly empty)"}`);
  };

  const notReviewed = Object.fromEntries(Object.values(NEEDS_REVIEW_COLUMNS).map((k) => [k, false]));
  const activities: LegacyActivity[] = rowsOf(need("8.10"), (c) => ({
    ...(notReviewed as unknown as Pick<LegacyActivity, (typeof NEEDS_REVIEW_COLUMNS)[keyof typeof NEEDS_REVIEW_COLUMNS]>),
    Id: c.reqInt("Id"),
    StartDateTime: c.wall("StartDateTime"), EndDateTime: c.wall("EndDateTime"), NRDateTime: c.wall("NRDateTime"),
    PotentialDates: c.str("PotentialDates"),
    Title: c.text("Title"), Details: c.text("Details"), Schedule: c.text("Schedule"), Significance: c.text("Significance"),
    Strategy: c.str("Strategy"), Comments: c.str("Comments"), HqComments: c.str("HqComments"),
    LeadOrganization: c.str("LeadOrganization"), Venue: c.str("Venue"), OtherCity: c.str("OtherCity"), Translations: c.str("Translations"),
    StatusId: c.int("StatusId"), HqStatusId: c.int("HqStatusId"), HqSection: c.reqInt("HqSection"),
    NRDistributionId: c.int("NRDistributionId"), PremierRequestedId: c.int("PremierRequestedId"), ContactMinistryId: c.guid("ContactMinistryId"),
    GovernmentRepresentativeId: c.int("GovernmentRepresentativeId"), CommunicationContactId: c.int("CommunicationContactId"),
    EventPlannerId: c.int("EventPlannerId"), VideographerId: c.int("VideographerId"), CityId: c.int("CityId"),
    IsActive: c.reqBool("IsActive"), IsConfirmed: c.reqBool("IsConfirmed"), IsIssue: c.reqBool("IsIssue"), IsAllDay: c.reqBool("IsAllDay"),
    IsAtLegislature: c.reqBool("IsAtLegislature"), IsConfidential: c.reqBool("IsConfidential"), IsCrossGovernment: c.reqBool("IsCrossGovernment"),
    IsMilestone: c.reqBool("IsMilestone"),
    CreatedDateTime: c.wall("CreatedDateTime"), CreatedBy: c.int("CreatedBy"), LastUpdatedDateTime: c.wall("LastUpdatedDateTime"), LastUpdatedBy: c.int("LastUpdatedBy"),
  }));

  const joins = {} as Record<JoinTable, LegacyJoinRow[]>;
  for (const t of JOIN_TABLES) {
    const j = JOIN_SECTION[t];
    joins[t] = rowsOf(need(j.label), (c) => ({ ActivityId: c.reqInt("ActivityId"), ValueId: j.guid ? c.reqGuid(j.column) : c.reqInt(j.column), IsActive: c.reqBool("IsActive") }));
  }

  const lookups = {} as Record<LookupTable, LegacyLookup[]>;
  for (const t of LOOKUP_TABLES) {
    const l = LOOKUP_SECTION[t];
    lookups[t] = rowsOf(need(l.label), (c) => {
      const row: LegacyLookup = { Id: c.reqInt("Id"), Name: c.str("Name"), SortOrder: c.int("SortOrder"), IsActive: c.bool("IsActive") };
      for (const x of l.extra) (row as unknown as Record<string, string | null>)[x] = c.str(x);
      return row;
    });
  }

  const contactRows = rowsOf(need("8.32"), (c) => ({
    contact: { Id: c.reqInt("Id"), SystemUserId: c.reqInt("SystemUserId"), MinistryId: c.guid("MinistryId"), SortOrder: c.int("SortOrder"), IsActive: c.bool("IsActive") } satisfies LegacyCommContact,
    name: c.text("Name"),
  }));
  const commContacts = contactRows.map((r) => r.contact);

  const linkCounts = new Map<number, number>();
  for (const id of rowsOf(need("8.20"), (c) => c.reqInt("ActivityId"))) linkCounts.set(id, (linkCounts.get(id) ?? 0) + 1);
  const releaseLinks: LegacyReleaseLink[] = [...linkCounts].sort(([a], [b]) => a - b).map(([ActivityId, N]) => ({ ActivityId, N }));

  const keyRows = (label: string) => rowsOf(need(label), (c) => ({
    Id: c.reqGuid("Id"), Key: c.reqText("Key"), DisplayName: c.text("DisplayName"),
    Abbreviation: c.str("Abbreviation"), SortOrder: c.int("SortOrder"), IsActive: c.reqBool("IsActive"),
  }));
  const keys: LegacyKeyRows = { ministries: keyRows("8.43"), sectors: keyRows("8.44"), themes: keyRows("8.45"), tags: keyRows("8.46") };

  const referenced = new Set(activities.map((a) => a.CommunicationContactId).filter((id): id is number => id !== null));
  const users = o.usersFromCommContacts ? usersFromContacts(contactRows, referenced) : [];
  const notProvided: OptionalTable[] = [...(o.usersFromCommContacts ? [] : (["users"] as const)), "userMinistries", "savedFilters", "favourites", "files", "logs"];
  const notes = ["needs-review flags aren't in the export: imported as none"];
  if (o.usersFromCommContacts) notes.push("users are made from comm contacts: names only, no email, no role, inactive");

  return {
    snapshot: {
      activities, joins, users, userMinistries: [], commContacts, savedFilters: [], favourites: [], files: [], logs: [], lookups, releaseLinks,
      totals: { activities: activities.length, favourites: 0, files: 0, logs: 0 },
      provenance: { notProvided, usersFromCommContacts: o.usersFromCommContacts, notes },
    },
    keys, encodings, ignoredSections: ignored,
  };
}

/** One user per SystemUserId, named from its lowest-id contact an activity uses, else its lowest-id active one, else its lowest-id one. */
function usersFromContacts(rows: { contact: LegacyCommContact; name: string }[], referenced: Set<number>): LegacyUser[] {
  const rank = (r: { contact: LegacyCommContact }) => [referenced.has(r.contact.Id) ? 0 : 1, r.contact.IsActive === true ? 0 : 1, r.contact.Id] as const;
  const best = new Map<number, { contact: LegacyCommContact; name: string }>();
  for (const r of rows) {
    const cur = best.get(r.contact.SystemUserId);
    if (!cur || compare(rank(r), rank(cur)) < 0) best.set(r.contact.SystemUserId, r);
  }
  return [...best].sort(([a], [b]) => a - b).map(([Id, r]) => ({
    Id, RoleId: 0, DisplayName: r.name, FullName: null, EmailAddress: null, IsActive: false,
    JobTitle: null, PhoneNumber: null, MobileNumber: null, Description: null, FilterDisplayValue: null, HiddenColumns: null, LastUpdatedDateTime: null,
  }));
}
const compare = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };
