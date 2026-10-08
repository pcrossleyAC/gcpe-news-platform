import type { Request } from "express";

/** The caller tried to lock themself out (deactivate themself, or drop their own admin role). */
export class SelfLockoutError extends Error {}

// Compared canonically: the same id in another case (or with stray whitespace) is still the caller.
const canonical = (id: string) => id.trim().toLowerCase();

/** Whether the route's `:id` is the verified caller. */
export const isSelf = (req: Request<{ id: string }>) => req.auth !== undefined && canonical(req.auth.subject) === canonical(req.params.id);
