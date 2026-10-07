/**
 * Report CSVs: UTF-8 with a BOM (Excel reads anything else as the local code page), CRLF and
 * RFC 4180 quoting, streamed in batches with backpressure. A text cell a spreadsheet would run as
 * a formula gets a leading apostrophe (OWASP "CSV injection"): release titles and addresses are
 * typed by people outside staff's control.
 */
import type { Response } from "express";

export type CsvCell = string | number | null | undefined;
export const CSV_BOM = "﻿";

const FORMULA_START = /^[=+\-@\t\r]/;
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

class ClientGoneError extends Error {
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

/**
 * Streams `batches` as a CSV attachment and returns how many rows went out. The first batch is
 * fetched before anything is sent, so a query that fails at once still gets the caller's JSON
 * error. After the first byte, a failure destroys the connection: the browser shows a failed
 * download, never a short file that looks whole. Rows are never logged.
 */
export async function streamCsv(res: Response, filename: string, header: string[], batches: AsyncIterable<CsvCell[][]>): Promise<number> {
  const it = batches[Symbol.asyncIterator]();
  let next = await it.next();
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
    res.destroy();
    throw e;
  }
}
