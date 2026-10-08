import type { Response } from "express";
import { ZodError } from "zod";
import { safeErrorLabel } from "@gcpe/http-kit";
import {
  ActivityDeletedError, ActivityForbiddenError, ActivityLockedError, ActivityNotFoundError, ActivityValidationError, VersionConflictError,
} from "../activities/errors";
import { FreezeError } from "../freeze";

/** SQLSTATE class 23: integrity constraint violation. */
const CONSTRAINT_VIOLATION = /^23[0-9A-Z]{3}$/;
/** SQLSTATE class 22: data exception (an out-of-range number, a NUL character, a bad timestamp). */
const DATA_EXCEPTION = /^22[0-9A-Z]{3}$/;

/** Maps the activity service's typed errors to a response; false leaves the error to the generic 500. */
export function sendActivityError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
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
    console.error("[calendar] activity write hit a constraint", label);
    return void res.status(409).json({ code: "conflict", error: "That change conflicts with another one: reload and try again" }), true;
  }
  if (DATA_EXCEPTION.test(label)) {
    // The request schemas refuse every value the database can't hold; this catches one they missed, never a 500.
    console.error("[calendar] activity request hit an invalid value", label);
    return void res.status(400).json({ error: "invalid value" }), true;
  }
  return false;
}
