/** Business-rule problems the editor can fix (→ HTTP 422, `{ errors: problems }`). */
export class SiteRuleError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" "));
  }
}

/** Optimistic-concurrency conflict: the row's version didn't match (→ HTTP 409). */
export class SiteConflictError extends Error {
  constructor(message = "Someone else changed this — reload to see their changes") {
    super(message);
  }
}

/** → HTTP 404. */
export class SiteNotFoundError extends Error {}
