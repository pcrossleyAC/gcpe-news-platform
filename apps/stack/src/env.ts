import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The stack's own env — one PORT for every mounted app, a tick token, and the two feature
 * toggles main.ts needs (STACK_LOOPS for the background interval loops, UPDATES_HUB_ENABLED
 * for News API's SignalR hub — off by default per the SiteGround facts: WebSocket upgrades
 * are stripped by the proxy). */
export const stackEnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  // >= 32 chars, same bar as LOCAL_AUTH_SECRET — required at startup so a misconfigured
  // deployment fails fast instead of exposing /stack/tick behind a guessable token.
  TICK_TOKEN: z.string().min(32, "TICK_TOKEN must be at least 32 characters"),
  STACK_LOOPS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  UPDATES_HUB_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Loaded once, early, for the stack-wide P2-R17 time-zone self-check (assertTimeZoneRules)
  // — independent of (but defaulting to the same file as) News API's and Public Site's own
  // per-app loads of the same config.
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
});
export type StackEnv = z.infer<typeof stackEnvSchema>;

/** The six app prefixes the stack reads `<PREFIX>_<VAR>` env vars under (see task-14-brief.md). */
export const APP_PREFIXES = ["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST"] as const;
export type AppPrefix = (typeof APP_PREFIXES)[number];

/**
 * Shared vars every app's env view inherits unprefixed, verbatim: LOCAL_ADMIN_* (the whole
 * family), LOCAL_AUTH_SECRET, TENANT_CONFIG, NODE_ENV, and (fix round 1, P2-R30 M6)
 * ENTRA_TENANT_ID — every app talks to the same Entra tenant, so that one is shared too.
 * AUTH_AUDIENCE is deliberately NOT shared: each app is its own audience/resource in Entra
 * (`<PREFIX>_AUTH_AUDIENCE`), same as it would be as six separate deployments.
 */
function isSharedKey(key: string): boolean {
  return key === "NODE_ENV" || key === "TENANT_CONFIG" || key === "LOCAL_AUTH_SECRET" || key === "ENTRA_TENANT_ID" || key.startsWith("LOCAL_ADMIN_");
}

/**
 * Builds the env view passed to one app's `start<App>(env)`: every shared var, plus every
 * `${prefix}_VAR` in `env` with the prefix stripped to `VAR` (e.g. `NRMS_DATABASE_URL` ->
 * `DATABASE_URL`). A prefixed var always wins over a shared one of the same name (applied
 * second, so it can override) — in practice the two sets don't collide since no app's own
 * schema uses a shared var's exact name for something else.
 */
export function envFor(env: NodeJS.ProcessEnv, prefix: AppPrefix): NodeJS.ProcessEnv {
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && isSharedKey(key)) view[key] = value;
  }
  const withUnderscore = `${prefix}_`;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith(withUnderscore)) view[key.slice(withUnderscore.length)] = value;
  }
  return view;
}

const SELF_PREFIX = "self:";

function stripSelfPrefix(url: string): string {
  return url.slice(SELF_PREFIX.length); // "self:/events" -> "/events"
}

function isSelfUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${SELF_PREFIX}/`);
}

/** A subscriber entry shaped closely enough to know its `url` field is the one to rewrite,
 * without otherwise caring what else is on it (name/secret/types) — `secret` in particular
 * must never be touched even if it happens to contain the literal text "self:/" (fix round 1,
 * P2-R30 M1). */
function hasUrlField(item: unknown): item is { url: unknown } & Record<string, unknown> {
  return typeof item === "object" && item !== null && "url" in item;
}

/**
 * Resolves Task 15's `self:` subscriber URLs inside a raw EVENT_SUBSCRIBERS JSON string: every
 * subscriber's `url` field starting with `self:/` becomes `http://127.0.0.1:<actualPort>/rest`
 * once the stack's single port is known (pulled forward from Task 15's brief — the stack needs
 * this to wire events between its own apps; see stack.ts).
 *
 * Parses the JSON and rewrites only the `url` field of each entry (fix round 1, P2-R30 M1) —
 * never a blind string replace over the raw text, which would also rewrite a `secret` that
 * happened to contain the literal substring "self:/". Malformed JSON is passed through
 * unchanged so `parseSubscribers` (inside each app's own start()) reports the real parse
 * error, instead of this function masking it with a different one. A no-op when `value` is
 * undefined.
 */
export function resolveSelfSubscribers(value: string | undefined, actualPort: number): string | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(parsed)) return value;
  const rewritten = parsed.map((item) => {
    if (hasUrlField(item) && isSelfUrl(item.url)) {
      return { ...item, url: `http://127.0.0.1:${actualPort}${stripSelfPrefix(item.url)}` };
    }
    return item;
  });
  return JSON.stringify(rewritten);
}

/**
 * Resolves every `self:/…` URL in one app's already-prefix-stripped env view to a concrete
 * loopback URL at the stack's own port (fix round 1, P2-R30 — important fix 1 and M9):
 * `EVENT_SUBSCRIBERS` (via {@link resolveSelfSubscribers}, scoped to each entry's `url`
 * field), and every *other* var whose name ends in `_URL` whose whole value is a `self:/…`
 * URL — e.g. `NEWS_API_URL`, `DISTRIBUTION_URL`, `NOD_BASE_URL` (News API's own var name for
 * NoD's base URL, seen here as `NEWSAPI_NOD_BASE_URL` before `envFor` strips the prefix).
 * An external URL (a real public domain, or an OAuth2/Entra token endpoint) never starts with
 * `self:/`, so this never touches one — "leave external token URLs alone" falls out of the
 * same check, with no separate case needed for them.
 */
export function resolveSelfUrls(env: NodeJS.ProcessEnv, actualPort: number): NodeJS.ProcessEnv {
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "EVENT_SUBSCRIBERS") {
      view[key] = resolveSelfSubscribers(value, actualPort)!;
    } else if (key.endsWith("_URL") && isSelfUrl(value)) {
      view[key] = `http://127.0.0.1:${actualPort}${stripSelfPrefix(value)}`;
    } else {
      view[key] = value;
    }
  }
  return view;
}
