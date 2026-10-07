/**
 * Report CSVs: UTF-8 with a BOM (Excel reads anything else as the local code page), CRLF and
 * RFC 4180 quoting, streamed in batches with backpressure. A text cell a spreadsheet would run as
 * a formula gets a leading apostrophe (OWASP "CSV injection"): release titles and addresses are
 * typed by people outside staff's control.
 */
import type { Response } from "express";

export type CsvCell = string | number | null | undefined;
export const CSV_BOM = "﻿";

// A formula-lead character still counts as one once it's hidden behind leading whitespace
// (plain space, NBSP, a stray BOM) or a leading newline a spreadsheet's own cell-start scan skips
// past, and the full-width equals/plus/minus/at (U+FF1D/FF0B/FF0D/FF20) that an IME-aware formula
// parser treats the same as their ASCII counterparts.
const FORMULA_START = /^[\s﻿]*[=+\-@\t\r\n＝＋－＠]/;
const NEEDS_QUOTES = /[",\r\n]/;
/** Flushes to the socket once this much is buffered: fewer, larger writes. */
const FLUSH_AT = 64 * 1024;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = FORMULA_START.test(v) ? `'${v}` : v;
  if (NEEDS_QUOTES.test(s) || s !== s.trim()) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function csvLine(cells: CsvCell[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** `<report>-<YYYY-MM-DD>.csv`; report names are ours, never user input, and stay header-safe. */
export function csvFilename(report: string, today: string): string {
  if (!/^[a-z0-9-]+$/.test(report) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("invalid CSV filename");
  return `${report}-${today}.csv`;
}

export async function* oneBatch(rows: CsvCell[][]): AsyncGenerator<CsvCell[][]> {
  yield rows;
}

export async function* mapBatches<T>(batches: AsyncIterable<T[]>, toRow: (t: T) => CsvCell[]): AsyncGenerator<CsvCell[][]> {
  for await (const batch of batches) yield batch.map(toRow);
}

/** The browser closed the connection (navigated away, cancelled a download) while a report was
 * streaming. `privateErrorsWith` (http/private-errors.ts) knows this one by name: it's an
 * everyday cancellation, not a failure, and is never logged. */
export class ClientGoneError extends Error {
  constructor() {
    super("client went away");
    this.name = "ClientGoneError";
  }
}

async function write(res: Response, chunk: string): Promise<void> {
  if (res.destroyed) throw new ClientGoneError();
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ClientGoneError());
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

/** Closes `it` (a DB cursor, typically) without letting a cleanup failure mask the real error. */
async function close(it: AsyncIterator<CsvCell[][]>): Promise<void> {
  try {
    await it.return?.();
  } catch {
    // The caller is already unwinding on its own error (or the connection is gone); a failure
    // closing the generator has nothing useful to add.
  }
}

/**
 * Streams `batches` as a CSV attachment and returns how many rows went out. The first batch is
 * fetched before anything is sent, so a query that fails at once still gets the caller's JSON
 * error. After the first byte, a failure destroys the connection: the browser shows a failed
 * download, never a short file that looks whole. Rows are never logged.
 *
 * `onStart`, if given, runs once the first batch is already in hand -- after the point a failure
 * would have meant no export happened at all, so a caller that logs an audit row for the export
 * (report-routes.ts) logs one only for an export that actually started.
 */
export async function streamCsv(
  res: Response,
  filename: string,
  header: string[],
  batches: AsyncIterable<CsvCell[][]>,
  onStart?: () => Promise<unknown>,
): Promise<number> {
  const it = batches[Symbol.asyncIterator]();
  let next: IteratorResult<CsvCell[][]>;
  try {
    next = await it.next();
    if (onStart) await onStart();
  } catch (e) {
    // Before any byte: nothing was sent and nothing should look like it was -- the caller's own
    // handler turns this into a plain JSON error, same as any other pre-stream failure.
    await close(it);
    throw e;
  }
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let count = 0;
  try {
    // The header goes out at once: from here on, any failure is visible to the browser as an
    // aborted download.
    await write(res, CSV_BOM + csvLine(header));
    let buffer = "";
    while (!next.done) {
      // A tiny batch may never trigger the flush below, so `write` alone would only notice a
      // disconnected client on some later batch, long after the client gave up: checked here,
      // once per batch, instead of once per flush.
      if (res.destroyed || res.writableEnded) throw new ClientGoneError();
      for (const row of next.value) {
        buffer += csvLine(row);
        count++;
        if (buffer.length >= FLUSH_AT) {
          await write(res, buffer);
          buffer = "";
        }
      }
      next = await it.next();
    }
    await write(res, buffer);
    res.end();
    return count;
  } catch (e) {
    await close(it);
    res.destroy();
    throw e;
  }
}
