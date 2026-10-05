import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export interface ErrorEntry {
  timestamp: string;
  message: string;
  /** This process's pid, so a reader can tell which process (of possibly several, across
   * restarts) logged a given entry. */
  pid: number;
  /** This process's own start time (ISO), the same value `/stack/health` reports — lets a
   * reader see, at a glance, which entries predate the most recent restart. */
  startedAt: string;
}

export interface ErrorCaptureOptions {
  /** Ring size, in memory and (when `filePath` is set) on disk. Default 200 — unchanged from
   * the old in-memory-only behaviour when no `filePath` is given. */
  limit?: number;
  /**
   * JSON-lines file to append captured entries to, e.g. `<DATA_DIR>/logs/errors.jsonl` — the
   * same DATA_DIR that already survives a SiteGround idle-kill restart or redeploy (see
   * data-dir.ts and the fake Flickr's own `statePath`). Omitted (every test but the stack's
   * own, and any other caller that doesn't need durability) keeps the old in-memory-only
   * behaviour: nothing is read or written on disk.
   *
   * Loaded once at construction — a missing or unreadable/corrupt file is treated the same as
   * "nothing persisted yet", never a startup failure. Every append is a best-effort
   * `appendFileSync`; a write failure (unwritable DATA_DIR, disk full, …) is swallowed and must
   * never throw into the `console.error` caller, and must never itself call `console.error` —
   * that would recurse straight back into the very wrapper this module installs.
   */
  filePath?: string;
  /** This process's own start time (ISO). Defaults to now. */
  startedAt?: string;
}

export interface ErrorCapture {
  /** The last `limit` console.error calls, oldest first. */
  entries(): ErrorEntry[];
  /** Restores the original console.error. */
  close(): void;
}

const DEFAULT_LIMIT = 200;
/** Once the file has accumulated this many multiples of the cap since the last rewrite, it's
 * rewritten back down to exactly the (already-capped) in-memory ring — keeps most appends a
 * cheap `appendFileSync` instead of rewriting the whole file on every single call. */
const TRIM_FACTOR = 1.5;

function isErrorEntry(e: unknown): e is ErrorEntry {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ErrorEntry).timestamp === "string" &&
    typeof (e as ErrorEntry).message === "string" &&
    typeof (e as ErrorEntry).pid === "number" &&
    typeof (e as ErrorEntry).startedAt === "string"
  );
}

/** Reads and parses `filePath` (one JSON object per line), dropping any corrupt line rather
 * than the whole file, and trimming to the most recent `cap` entries. A missing or wholly
 * unreadable file is the same as "nothing persisted yet" (first boot ever). */
function loadPersisted(filePath: string, cap: number): ErrorEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const entries: ErrorEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isErrorEntry(parsed)) entries.push(parsed);
    } catch {
      // One corrupt line doesn't lose the rest of the file.
    }
  }
  return entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

/** Rewrites `filePath` to hold exactly `entries` (oldest first), one JSON object per line.
 * Best effort: never throws, and never calls `console.error` (see {@link ErrorCaptureOptions.filePath}). */
function rewrite(filePath: string, entries: ErrorEntry[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  } catch {
    // Swallow — see the write-failure contract on ErrorCaptureOptions.filePath.
  }
}

/** Appends one entry to `filePath`. Best effort: never throws, never calls `console.error`. */
function append(filePath: string, entry: ErrorEntry): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Swallow — see the write-failure contract on ErrorCaptureOptions.filePath.
  }
}

/**
 * Wraps the global `console.error` so GET /stack/errors can return the last `limit` calls
 * (timestamp + formatted message) — a cold-started, idle-killed SiteGround process has no
 * reachable runtime logs over SSH (see siteground-facts.md), so this is the only place an
 * operator can see what an app most recently logged. Every call still reaches the original
 * console.error unchanged (stderr output is untouched); secrets are never logged by any app's
 * own code in the first place (see e.g. packages/auth), so this capture doesn't add a new way
 * for one to leak — it just mirrors what was already being printed.
 *
 * With `filePath` (used by the stack; omitted by most tests), entries are also persisted to a
 * JSON-lines file under DATA_DIR so the log survives the idle-kill restart that otherwise wipes
 * it (docs/deploy/siteground.md "Troubleshooting") — existing entries are loaded at
 * construction, and the file is kept to a bounded ring of the most recent `limit` entries.
 */
export function installErrorCapture(options: number | ErrorCaptureOptions = {}): ErrorCapture {
  const opts: ErrorCaptureOptions = typeof options === "number" ? { limit: options } : options;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const filePath = opts.filePath;
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const pid = process.pid;

  const buffer: ErrorEntry[] = filePath ? loadPersisted(filePath, limit) : [];
  // Startup trim: if the file on disk already holds more than the cap (the cap shrank since it
  // was written, or a previous process never got to trim it), rewrite it down right away
  // instead of waiting for the next capture to cross the 1.5x threshold below.
  if (filePath) rewrite(filePath, buffer);
  // Tracks appends (not full rewrites) against this file since the last rewrite, so the file
  // never grows past ~TRIM_FACTOR * limit lines before being rewritten back down to `limit`.
  let appendsSinceRewrite = buffer.length;

  const original = console.error;
  console.error = ((...args: unknown[]) => {
    const entry: ErrorEntry = { timestamp: new Date().toISOString(), message: format(...args), pid, startedAt };
    buffer.push(entry);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    if (filePath) {
      append(filePath, entry);
      appendsSinceRewrite++;
      if (appendsSinceRewrite > limit * TRIM_FACTOR) {
        rewrite(filePath, buffer);
        appendsSinceRewrite = buffer.length;
      }
    }
    original.apply(console, args);
  }) as typeof console.error;
  return {
    entries: () => buffer.slice(),
    close: () => {
      console.error = original;
    },
  };
}
