/**
 * The NoD importer's report, shaped like the NRMS importer's: per legacy table, legacy =
 * imported + skipped. Skipped rows are grouped by reason, with up to 10 sample ids. Ids are
 * legacy GUIDs only. Anything else passed as an id is withheld, so an address can never reach
 * this file. Reasons are fixed text written by the importer, never legacy content.
 */

export type ReportSide = "legacy" | "imported" | "skipped";

interface TableCounts {
  legacy: number;
  imported: number;
  skipped: number;
}

export interface SkipGroup {
  table: string;
  reason: string;
  count: number;
  sample: string[];
}

export interface NodImportReportJSON {
  balanced: boolean;
  tables: Record<string, TableCounts>;
  skipped: SkipGroup[];
  notes: string[];
  failed: { stage: string; message: string } | null;
}

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_RE = new RegExp(`^${GUID}(/${GUID})?$`, "i");
const SAMPLE_SIZE = 10;

export class NodImportReport {
  private readonly tables = new Map<string, TableCounts>();
  private readonly skips = new Map<string, SkipGroup>();
  private readonly notes: string[] = [];
  private failed: { stage: string; message: string } | null = null;

  count(table: string, side: ReportSide, n = 1): void {
    const row = this.tables.get(table) ?? { legacy: 0, imported: 0, skipped: 0 };
    row[side] += n;
    this.tables.set(table, row);
  }

  skip(table: string, reason: string, legacyId: string): void {
    this.count(table, "skipped");
    const key = `${table}\u0000${reason}`;
    const group = this.skips.get(key) ?? { table, reason, count: 0, sample: [] };
    group.count += 1;
    if (group.sample.length < SAMPLE_SIZE) group.sample.push(ID_RE.test(legacyId) ? legacyId.toLowerCase() : "(id withheld)");
    this.skips.set(key, group);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** `message` must already be redacted and length-capped (run.ts does this). */
  markFailed(stage: string, message: string): void {
    this.failed = { stage, message };
  }

  balanced(): boolean {
    if (this.failed) return false;
    for (const t of this.tables.values()) if (t.legacy !== t.imported + t.skipped) return false;
    return true;
  }

  toJSON(): NodImportReportJSON {
    return {
      balanced: this.balanced(),
      tables: Object.fromEntries([...this.tables.entries()].sort(([a], [b]) => a.localeCompare(b))),
      skipped: [...this.skips.values()].sort((a, b) => a.table.localeCompare(b.table) || b.count - a.count),
      notes: [...this.notes],
      failed: this.failed ? { ...this.failed } : null,
    };
  }

  toText(): string {
    const j = this.toJSON();
    const head = `NoD import report — ${j.balanced ? "balanced" : "NOT BALANCED"}`;
    const lines = [j.failed ? `${head} — failed during ${j.failed.stage}: ${j.failed.message}` : head];
    for (const [table, c] of Object.entries(j.tables)) lines.push(`  ${table}: legacy=${c.legacy} imported=${c.imported} skipped=${c.skipped}`);
    if (j.skipped.length > 0) {
      lines.push("Skipped:");
      for (const s of j.skipped) lines.push(`  [${s.table}] ${s.count} × ${s.reason} (e.g. ${s.sample.slice(0, 3).join(", ")})`);
    }
    if (j.notes.length > 0) {
      lines.push("Notes:");
      for (const n of j.notes) lines.push(`  ${n}`);
    }
    return lines.join("\n");
  }
}
