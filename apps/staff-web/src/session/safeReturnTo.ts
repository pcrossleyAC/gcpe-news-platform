/**
 * Validates a `?return=` value before SignIn hands it to react-router's `<Navigate>`. Only a
 * same-origin absolute path is accepted — react-router's own history/resolution doesn't refuse
 * a protocol-relative ("//evil.com") or absolute ("https://evil.com") target on its own, so
 * this check has to happen here, not be assumed from how `<Navigate>` resolves its `to` prop.
 * Anything else (missing, empty, no leading slash, protocol-relative, absolute) falls back to
 * "/".
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
