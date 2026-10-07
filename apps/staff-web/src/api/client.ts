/**
 * The staff web app's one HTTP client (Task 1). Every API call goes through {@link apiFetch}
 * so the CSRF header, credentials, and error shape (constraints.md) are applied exactly once,
 * in exactly one place.
 */

/** The CSRF header every non-GET/HEAD cookie request must send (packages/auth/src/session.ts's
 * CSRF_HEADER, "x-gcpe-request" — duplicated as a literal here since browser code can never
 * import @gcpe/auth, a Node-only package: it depends on express, jose, etc.). */
const CSRF_HEADER = "X-GCPE-Request";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface ApiErrorInit {
  status: number;
  message: string;
  problems?: string[];
  issues?: unknown[];
  /** I2: a 409's machine-readable reason ("version_conflict" vs "state" —
   * apps/nrms/src/http/routes.ts's handleError) — undefined for 409s from before this was
   * added, and for every other status. Callers that only care about "was this a real version
   * conflict" check `code !== "state"` rather than requiring it to be present. */
  code?: string;
  /** Task 5: the whole parsed response body, when there was one — e.g. the Subscribers
   * section's 409 `{ error: "subscriber exists", id }`, whose `id` no other field above
   * carries. Undefined when the body didn't parse as JSON or there wasn't one. */
  body?: unknown;
}

/** Thrown by {@link apiFetch} for any non-2xx response. `problems` (422) and `issues` (400)
 * carry the server's own structured detail, when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly problems?: string[];
  readonly issues?: unknown[];
  readonly code?: string;
  readonly body?: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.problems = init.problems;
    this.issues = init.issues;
    this.code = init.code;
    this.body = init.body;
  }
}

export type UnauthorizedListener = (returnTo: string) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribes to apiFetch's 401s (SessionContext's own use); returns an unsubscribe function. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized(returnTo: string): void {
  for (const listener of unauthorizedListeners) listener(returnTo);
}

export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  /** Plain data, JSON-stringified here — never a pre-encoded string/FormData/Blob. */
  body?: unknown;
  /** Task 4: a raw upload body (release file/translation uploads, `POST .../files?...`) — sent
   * exactly as given, with no JSON encoding and no Content-Type forced (the browser sets its
   * own for a Blob; the server judges bytes by magic number, not the declared type). Mutually
   * exclusive with `body`. */
  raw?: BodyInit;
}

function currentReturnPath(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Same-origin JSON fetch (constraints.md): adds the CSRF header on every non-GET/HEAD request,
 * always sends `credentials: "same-origin"`, and turns any non-2xx response into a thrown
 * {@link ApiError}. A 401 additionally notifies every {@link onUnauthorized} listener with the
 * page the caller was on, so the session context can send them to sign-in and back.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  if (init.body !== undefined && init.raw !== undefined) {
    throw new Error("apiFetch: provide at most one of body or raw.");
  }

  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has(method)) headers.set(CSRF_HEADER, "1");

  let body: BodyInit | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
  } else if (init.body !== undefined) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }

  const res = await fetch(path, { ...init, method, headers, credentials: "same-origin", body });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized(currentReturnPath());
    const errObj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    // Task 5: the Website section's 422s (apps/nrms/src/website/errors.ts's SiteRuleError,
    // mapped in apps/nrms/src/http/routes.ts's handleError) send `{ errors: string[] }` with no
    // `error`/`problems` at all — a different shape from every release 422 (`{error, problems}`).
    // `errors` is read here as a `problems` fallback (never the reverse) so one error shape
    // doesn't shadow the other; no server response mixes the two keys.
    const problems = Array.isArray(errObj.problems)
      ? (errObj.problems as string[])
      : Array.isArray(errObj.errors)
        ? (errObj.errors as string[])
        : undefined;
    const message = typeof errObj.error === "string" ? errObj.error : problems ? problems.join(" ") : text || `Request failed (${res.status})`;
    throw new ApiError({
      status: res.status,
      message,
      problems,
      issues: Array.isArray(errObj.issues) ? (errObj.issues as unknown[]) : undefined,
      code: typeof errObj.code === "string" ? errObj.code : undefined,
      body: data,
    });
  }

  return data as T;
}
