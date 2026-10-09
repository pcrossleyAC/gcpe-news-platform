import type { Response } from "express";
import { z, ZodError } from "zod";
import { safeErrorLabel } from "@gcpe/http-kit";
import {
  ActivityDeletedError, ActivityForbiddenError, ActivityLockedError, ActivityNotFoundError, ActivityValidationError, VersionConflictError,
} from "../activities/errors";
import { FreezeError } from "../freeze";

/** SQLSTATE class 23: integrity constraint violation. */
const CONSTRAINT_VIOLATION = /^23[0-9A-Z]{3}$/;
/** SQLSTATE 40001 (serialization failure) and 40P01 (deadlock detected): the transaction lost a race and can simply be retried. */
const TRANSIENT = new Set(["40001", "40P01"]);
/** SQLSTATE class 22: data exception (an out-of-range number, a NUL character, a bad timestamp). */
const DATA_EXCEPTION = /^22[0-9A-Z]{3}$/;

/** The parts of a request a log line may name: never the query string, which can hold search text. */
export type RouteOf = { method: string; baseUrl: string; path: string };
const routeOf = (req?: RouteOf) => (req ? `${req.method} ${req.baseUrl}${req.path}` : "");

/**
 * Zod's own message for these two codes embeds the attacker-chosen text verbatim (the unrecognized
 * key's name, or the enum value received): a static message per code instead, never the schema's.
 */
const STATIC_ZOD_MESSAGE: Partial<Record<z.ZodIssueCode, string>> = {
  unrecognized_keys: "Unrecognized key(s) in object",
  invalid_enum_value: "Invalid enum value",
};

/** Every field a Zod issue can carry (`received`, `keys`, `options`, …) but these three: nothing
 * attacker-chosen reaches the response through a side channel even where the message is safe. */
function zodIssues(e: ZodError): { path: (string | number)[]; code: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path, code: i.code, message: STATIC_ZOD_MESSAGE[i.code] ?? i.message }));
}

/** Maps the activity service's typed errors to a response; false leaves the error to the generic 500. */
export function sendActivityError(e: unknown, res: Response, req?: RouteOf): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: zodIssues(e) }), true;
  if (e instanceof ActivityNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ActivityForbiddenError) return void res.status(403).json({ error: e.message }), true;
  if (e instanceof FreezeError) return void res.status(423).json({ code: "freeze", error: e.message }), true;
  if (e instanceof ActivityLockedError) return void res.status(423).json({ code: e.code, error: e.message, holder: e.holder }), true;
  if (e instanceof VersionConflictError) return void res.status(409).json({ code: "version_conflict", error: e.message }), true;
  if (e instanceof ActivityDeletedError) return void res.status(409).json({ code: "deleted", error: e.message }), true;
  if (e instanceof ActivityValidationError) return void res.status(422).json({ error: "Fix the fields named", errors: e.errors }), true;
  const label = safeErrorLabel(e);
  if (CONSTRAINT_VIOLATION.test(label)) {
    // Validation makes every constraint unreachable; this catches a race it missed, never a 500.
    console.error("[calendar] activity write hit a constraint", label, routeOf(req));
    return void res.status(409).json({ code: "conflict", error: "That change conflicts with another one: reload and try again" }), true;
  }
  if (TRANSIENT.has(label)) {
    console.error("[calendar] activity write lost a race", label, routeOf(req));
    return void res.status(409).json({ code: "retry", error: "Someone else was saving at the same time: try again." }), true;
  }
  if (DATA_EXCEPTION.test(label)) {
    // The request schemas refuse every value the database can't hold; this catches one they missed, never a 500.
    console.error("[calendar] activity request hit an invalid value", label, routeOf(req));
    return void res.status(400).json({ error: "invalid value" }), true;
  }
  return false;
}
