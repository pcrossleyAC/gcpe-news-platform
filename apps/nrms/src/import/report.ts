/**
 * Phase 3e (NRMS legacy importer, spec §8 "Safety" point 4): every import run writes a report
 * of legacy and NRMS row counts per table, skipped rows with reasons, and validation warnings.
 * `balanced()` is the acceptance check from §9/15: for every table, legacy rows = imported +
 * skipped rows. This class never accepts or holds connection details (no constructor args),
 * so there is nothing secret for toJSON()/toText() to leak.
 */

export type ReportSide = "legacy" | "imported" | "skipped";

interface TableCounts {
  legacy: number;
  imported: number;
  skipped: number;
}

interface SkippedRow {
  table: string;
  legacyId: string;
  reason: string;
}

interface Warning {
  legacyId: string;
  key: string;
  problems: string[];
}

export interface ImportReportJSON {
  balanced: boolean;
  tables: Record<string, TableCounts>;
  skipped: SkippedRow[];
  warnings: Warning[];
}

export class ImportReport {
  private readonly tables = new Map<string, TableCounts>();
  private readonly skipped: SkippedRow[] = [];
  private readonly warnings: Warning[] = [];

  private row(table: string): TableCounts {
    let row = this.tables.get(table);
    if (!row) {
      row = { legacy: 0, imported: 0, skipped: 0 };
      this.tables.set(table, row);
    }
    return row;
  }

  /** Adds `n` (default 1) to `table`'s count for `side`. */
  count(table: string, side: ReportSide, n = 1): void {
    this.row(table)[side] += n;
  }

  /** Records a legacy row that was deliberately not imported, with its reason. Also counts it as "skipped". */
  skip(table: string, legacyId: string, reason: string): void {
    this.count(table, "skipped");
    this.skipped.push({ table, legacyId, reason });
  }

  /** Records a validation problem on an imported row (imported anyway; must be fixed before publishing). */
  warn(legacyId: string, key: string, problems: string[]): void {
    this.warnings.push({ legacyId, key, problems });
  }

  /** True when, for every table, legacy = imported + skipped. */
  balanced(): boolean {
    for (const row of this.tables.values()) {
      if (row.legacy !== row.imported + row.skipped) return false;
    }
    return true;
  }

  toJSON(): ImportReportJSON {
    return {
      balanced: this.balanced(),
      tables: Object.fromEntries([...this.tables.entries()].sort(([a], [b]) => a.localeCompare(b))),
      skipped: [...this.skipped],
      warnings: [...this.warnings],
    };
  }

  toText(): string {
    const lines: string[] = [];
    const json = this.toJSON();
    lines.push(`Import report — ${json.balanced ? "balanced" : "NOT BALANCED"}`);
    for (const [table, c] of Object.entries(json.tables)) {
      lines.push(`  ${table}: legacy=${c.legacy} imported=${c.imported} skipped=${c.skipped}`);
    }
    if (json.skipped.length > 0) {
      lines.push("Skipped rows:");
      for (const s of json.skipped) lines.push(`  [${s.table}] ${s.legacyId}: ${s.reason}`);
    }
    if (json.warnings.length > 0) {
      lines.push("Validation warnings:");
      for (const w of json.warnings) lines.push(`  ${w.legacyId} (${w.key}): ${w.problems.join("; ")}`);
    }
    return lines.join("\n");
  }
}
