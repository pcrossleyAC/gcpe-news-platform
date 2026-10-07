/**
 * Distribution sent vs bounced (spec §8), from Distribution's own message records: per BC day and
 * sending app, and in total. Delivered = sent − bounces (hard and soft; legacy's Success =
 * Sent − Bounced). NoD's own messages are labelled; any other app shows its id.
 */
import type { DistributionClient } from "../distribution-client";
import type { CsvCell } from "./csv";
import { addDays, type ReportRange } from "./range";

export interface DeliveryCounts {
  sent: number;
  delivered: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}
export interface DistributionReport {
  from: string;
  to: string;
  totals: DeliveryCounts;
  apps: ({ app: string } & DeliveryCounts)[];
  days: ({ date: string; app: string } & DeliveryCounts)[];
}

const ZERO: DeliveryCounts = { sent: 0, delivered: 0, hardBounced: 0, softBounced: 0, failed: 0 };
const add = (a: DeliveryCounts, b: DeliveryCounts): DeliveryCounts => ({
  sent: a.sent + b.sent,
  delivered: a.delivered + b.delivered,
  hardBounced: a.hardBounced + b.hardBounced,
  softBounced: a.softBounced + b.softBounced,
  failed: a.failed + b.failed,
});

export async function distributionReport(client: Pick<DistributionClient, "dailyReport">, range: ReportRange, nodAppId: string): Promise<DistributionReport> {
  const { rows } = await client.dailyReport(range.bounds.map((b) => b.toISOString()));
  const label = (appId: string) => (appId === nodAppId ? "News On Demand" : appId);
  const days = rows
    .filter((r) => r.day >= 0 && r.day < range.days)
    .map((r) => ({
      date: addDays(range.from, r.day),
      app: label(r.appId),
      sent: r.sent,
      delivered: Math.max(0, r.sent - r.hardBounced - r.softBounced),
      hardBounced: r.hardBounced,
      softBounced: r.softBounced,
      failed: r.failed,
    }))
    .sort((a, b) => (a.date === b.date ? a.app.localeCompare(b.app) : b.date.localeCompare(a.date)));
  const countsOf = (d: DeliveryCounts): DeliveryCounts => ({ sent: d.sent, delivered: d.delivered, hardBounced: d.hardBounced, softBounced: d.softBounced, failed: d.failed });
  const byApp = new Map<string, DeliveryCounts>();
  for (const d of days) byApp.set(d.app, add(byApp.get(d.app) ?? ZERO, countsOf(d)));
  return {
    from: range.from,
    to: range.to,
    totals: days.reduce<DeliveryCounts>((t, d) => add(t, countsOf(d)), ZERO),
    apps: [...byApp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([app, c]) => ({ app, ...c })),
    days,
  };
}

export const DISTRIBUTION_CSV_HEADER = ["Date", "Sent by", "Sent", "Delivered", "Hard bounces", "Soft bounces", "Failed"];
export function distributionCsvRows(r: DistributionReport): CsvCell[][] {
  return r.days.map((d) => [d.date, d.app, d.sent, d.delivered, d.hardBounced, d.softBounced, d.failed]);
}
