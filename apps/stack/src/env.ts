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

/** Shared vars every app's env view inherits unprefixed, verbatim: LOCAL_ADMIN_* (the whole
 * family — ENABLED/ALLOW_IN_PRODUCTION/USERNAME/PASSWORD_HASH), LOCAL_AUTH_SECRET,
 * TENANT_CONFIG and NODE_ENV. Deliberately narrow — see task-14-report.md's deviations
 * section for why ENTRA_TENANT_ID/AUTH_AUDIENCE are NOT shared here. */
function isSharedKey(key: string): boolean {
  return key === "NODE_ENV" || key === "TENANT_CONFIG" || key === "LOCAL_AUTH_SECRET" || key.startsWith("LOCAL_ADMIN_");
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

/**
 * Resolves Task 15's `self:` subscriber URLs inside a raw EVENT_SUBSCRIBERS JSON string:
 * every `"self:/rest/of/path"` becomes `"http://127.0.0.1:<actualPort>/rest/of/path"` once the
 * stack's single port is known (pulled forward from Task 15's brief — the stack needs this to
 * wire events between its own apps; see stack.ts). A no-op when `value` is undefined, or
 * contains no `self:` URL.
 */
export function resolveSelfSubscribers(value: string | undefined, actualPort: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/self:(\/[^"\\]*)/g, (_match, rest: string) => `http://127.0.0.1:${actualPort}${rest}`);
}
