/**
 * Shared message redaction for anything that surfaces a raw driver/Postgres error to the import
 * report or a log line: drizzle's own error messages put every bound parameter inline ("Failed
 * query: … params: a,b,c"), and those values are arbitrary legacy content (or, in the worst
 * case, something that looks like a secret) that doesn't belong in a report a human reads.
 * Shared by releases.ts's `failureReason` and run.ts's `ImportStageError` (M5) so the two never
 * drift into redacting differently.
 */

/** Drops any line that is (or starts with, after leading whitespace) `params:`. */
export function stripParamsLines(message: string): string {
  return message
    .split("\n")
    .filter((line) => !/^\s*params:/.test(line))
    .join("\n")
    .trim();
}

const DEFAULT_MAX_LENGTH = 2_000;

/** Caps `message` to `maxLength` characters (default 2,000 — M5), marking the cut. */
export function capMessageLength(message: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}… [truncated]` : message;
}
