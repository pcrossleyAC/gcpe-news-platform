import type { FieldError } from "@gcpe/calendar-contract";

export class ActivityNotFoundError extends Error {
  override name = "ActivityNotFoundError";
}
/** A visible activity the caller may not act on. Not visible is ActivityNotFoundError (spec addendum §6). */
export class ActivityForbiddenError extends Error {
  override name = "ActivityForbiddenError";
}
/** A deleted activity is read-only; Review is its only action (spec addendum §6). */
export class ActivityDeletedError extends Error {
  override name = "ActivityDeletedError";
  constructor() {
    super("This activity is deleted");
  }
}
export class VersionConflictError extends Error {
  override name = "VersionConflictError";
  constructor() {
    super("Someone else changed this activity — reload to see their changes");
  }
}
export class ActivityLockedError extends Error {
  override name = "ActivityLockedError";
  constructor(
    readonly code: "locked" | "locked_elsewhere",
    message: string,
    readonly holder: { displayName: string; since: string } | null,
  ) {
    super(message);
  }
}
export class ActivityValidationError extends Error {
  override name = "ActivityValidationError";
  constructor(readonly errors: FieldError[]) {
    super("fix the fields named");
  }
}
