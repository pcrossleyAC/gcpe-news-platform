import type { ErrorRequestHandler } from "express";

// Extracts a 4xx status (e.g. body-parser's 413 PayloadTooLargeError or 400 on malformed
// JSON) from a thrown error, so client mistakes don't get flattened into a 500.
export function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const status = record.status ?? record.statusCode;
  return typeof status === "number" && status >= 400 && status <= 499 ? status : undefined;
}

// Relies on the `http-errors` convention (used by body-parser, and so by express.json()):
// `expose` is true only for 4xx errors whose message was written to be shown to the client
// (e.g. "request entity too large"), and false/absent for everything else. An error that
// doesn't follow that convention — anything without `expose === true` — gets a generic
// message, so an arbitrary thrown error's text (SQL, file paths) can never leak through here.
export function exposedMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    if (record.expose === true && typeof record.message === "string") return record.message;
  }
  return "request error";
}

/** A log-safe label for an arbitrary caught error. Never `e.message` or `e.cause.message`:
 * a query error's message routinely embeds whatever values the failing query bound (an SQL
 * driver's own `DrizzleQueryError`, for instance, formats as `"Failed query: <sql>\nparams:
 * <params>"`), so logging it risks putting an address, token or other sensitive value straight
 * into the logs. The error's own code (a Postgres error code, say, or one from `cause`) is
 * informative without ever carrying a bound value; failing that, its name. Shared so every
 * caller logs errors the same safe way instead of each reinventing this. */
export function safeErrorLabel(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "error";
}

/**
 * Terminal Express error handler: keeps failures as JSON, never finalhandler's default
 * HTML-with-stack. 4xx errors keep their status and (only if exposable) their message;
 * everything else is a generic 500.
 */
export function jsonErrorHandler(opts: { logPrefix: string }): ErrorRequestHandler {
  return (err, _req, res, next) => {
    console.error(`${opts.logPrefix} request failed`, err);
    if (res.headersSent) return next(err);
    const status = clientErrorStatus(err);
    if (status !== undefined) {
      return void res.status(status).json({ error: exposedMessage(err) });
    }
    res.status(500).json({ error: "internal error" });
  };
}
