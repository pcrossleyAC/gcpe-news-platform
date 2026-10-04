import { format } from "node:util";

export interface ErrorEntry {
  timestamp: string;
  message: string;
}

export interface ErrorCapture {
  /** The last `limit` console.error calls, oldest first. */
  entries(): ErrorEntry[];
  /** Restores the original console.error. */
  close(): void;
}

/**
 * Wraps the global `console.error` so GET /stack/errors can return the last `limit` calls
 * (timestamp + formatted message) — a cold-started, idle-killed SiteGround process has no
 * reachable runtime logs over SSH (see siteground-facts.md), so this is the only place an
 * operator can see what an app most recently logged. Every call still reaches the original
 * console.error unchanged (stderr output is untouched); secrets are never logged by any app's
 * own code in the first place (see e.g. packages/auth), so this capture doesn't add a new way
 * for one to leak — it just mirrors what was already being printed.
 */
export function installErrorCapture(limit = 200): ErrorCapture {
  const buffer: ErrorEntry[] = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    buffer.push({ timestamp: new Date().toISOString(), message: format(...args) });
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    original.apply(console, args);
  }) as typeof console.error;
  return {
    entries: () => buffer.slice(),
    close: () => {
      console.error = original;
    },
  };
}
