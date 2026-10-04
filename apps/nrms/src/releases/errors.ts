export class ReleaseNotFoundError extends Error {}
export class VersionConflictError extends Error {
  constructor() {
    super("Someone else changed this release — reload to see their changes");
  }
}
/** The action isn't allowed in the release's current state (HTTP 409). */
export class ReleaseStateError extends Error {}
/** Business-rule problems the editor can fix (HTTP 422). */
export class ReleaseRuleError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}
export class ReleaseTooLargeError extends Error {}
