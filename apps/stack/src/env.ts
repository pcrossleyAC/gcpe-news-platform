import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_ORIGIN } from "./internal-fetch";
import { createProjectionHandlers, SOURCE_EVENT_TYPES as NEWS_API_SOURCE_EVENT_TYPES } from "../../news-api/src/projections";
import { z } from "zod";

/** The Core-sourced event types the News API actually has a projection handler for, derived
 * (not hand-maintained) so a handler added or removed there automatically widens or narrows
 * this route. `service.upserted`/`service.deactivated` exist in the catalogue but have no News
 * API handler, so the derivation leaves them out. Core's `user.*` events carry staff emails and
 * must never reach the public News API, so they are excluded explicitly: a News API handler for
 * one must not be enough to route it there. */
export function newsApiEventTypesFromCore(handlers: Record<string, unknown> = createProjectionHandlers()): string[] {
  return Object.keys(handlers).filter((type) => NEWS_API_SOURCE_EVENT_TYPES.core!(type) && !/^user\./.test(type));
}

// Task 1 (staff-web): the staff app's built output directory. Two on-disk layouts share one
// default so no SiteGround setting is required: in dev (`tsx apps/stack/src/main.ts`),
// `import.meta.url` is this source file's own location and the build lives at
// apps/staff-web/dist; in the SiteGround bundle, this whole module is esbuild'd into one file
// at dist/siteground/stack.js, and build-siteground.mjs copies the staff-web build to
// dist/siteground/hub (`./hub`, relative to that same `import.meta.url`). Whichever of the
// two actually exists on disk at startup wins; an explicit STAFF_WEB_DIR env var always
// overrides both. Neither existing (dev, before the staff-web build has ever run) falls back
// to the dev path, so the 503 "Staff app not built" message names a sensible, existing-tree
// location rather than a path that can never be right.
const DEV_STAFF_WEB_DIR = fileURLToPath(new URL("../../staff-web/dist", import.meta.url));
const BUNDLED_STAFF_WEB_DIR = fileURLToPath(new URL("./hub", import.meta.url));

export function defaultStaffWebDir(): string {
  return existsSync(BUNDLED_STAFF_WEB_DIR) ? BUNDLED_STAFF_WEB_DIR : DEV_STAFF_WEB_DIR;
}

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
  // Optional: when set, the stack derives every app's internal EVENT_SUBSCRIBERS/EVENT_SECRETS
  // from it (see internalEventEnv) — one short setting instead of eight long JSON values, which
  // SiteGround's env form can't hold. Explicit <PREFIX>_EVENT_* vars still take precedence.
  STACK_EVENT_SECRET: z.string().min(32, "STACK_EVENT_SECRET must be at least 32 characters").optional(),
  // Task 1 (staff-web): see defaultStaffWebDir above for why a static default suffices for
  // both dev and the SiteGround bundle.
  STAFF_WEB_DIR: z.string().default(defaultStaffWebDir),
});
export type StackEnv = z.infer<typeof stackEnvSchema>;

/** The seven app prefixes the stack reads `<PREFIX>_<VAR>` env vars under. One process runs
 * every app, so each app's settings carry its prefix to keep apps that share a variable name
 * (each has its own DATABASE_URL, say) apart in the one environment. */
export const APP_PREFIXES = ["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"] as const;
export type AppPrefix = (typeof APP_PREFIXES)[number];

/** The Calendar runs only where its database exists: a SiteGround site needs it created by hand
 * in Site Tools, so a deploy before then must still start every other app. */
export function calendarConfigured(env: NodeJS.ProcessEnv): boolean {
  return !!env.CALENDAR_DATABASE_URL;
}

/**
 * Task 9: per-app defaults for vars that are always the same inside one stack and so need no
 * SiteGround setting of their own — NRMS's NoD base URL (used to show an editor roughly how
 * many subscribers a release will notify) and its Distribution base URL (Task 6's correction
 * notice) are both always this stack's own in-process `self:` URLs, same as NoD's own
 * DISTRIBUTION_URL default. An explicit `<PREFIX>_<VAR>` (e.g. `NRMS_NOD_URL`) still wins —
 * see envFor below, which applies this before the app's own prefixed vars.
 */
export const STACK_APP_DEFAULTS: Partial<Record<AppPrefix, Record<string, string>>> = {
  // Plan 3d task 4: Core's in-process URL too, for Project Blue Bridge's admin-directory lookup
  // (NRMS's own CORE_CLIENT_ID/SECRET stay unset in-stack, same as NOD_*/DISTRIBUTION_* — the
  // local-admin token fallback covers it, just like NRMS's calls to NoD and Distribution).
  NRMS: { NOD_URL: "self:/nod", DISTRIBUTION_URL: "self:/distribution", CORE_URL: "self:/core" },
  // Phase 4a: the public Subscribe API proxies to this stack's own NoD, same in-process-URL
  // pattern (and local-admin-token fallback) as NRMS's calls to NoD/Distribution/Core above.
  NEWSAPI: { NOD_BASE_URL: "self:/nod" },
};

/** Where the stack mounts its fake Flickr when no real Flickr key is configured. */
export const FAKE_FLICKR_PATH = "/fake-flickr";

/** The fake Flickr's fixed test credentials — not secrets: the fake only exists when no real
 * Flickr is configured, and it only guards its own in-memory photos. */
export const FAKE_FLICKR = {
  apiKey: "fake-key",
  apiSecret: "fake-secret-0123456789",
  accessToken: "fake-token",
  accessSecret: "fake-token-secret-0123456789",
} as const;

/** Where the stack mounts its fake Media Hub when NoD has no real one configured. */
export const FAKE_MEDIA_HUB_PATH = "/fake-media-hub";

/** What NoD's env view gets in fake mode: its own in-process URL. Unlike Flickr, the fake
 * Media Hub needs no credentials of its own -- its service routes are gated by a bearer+role
 * check the stack supplies at mount time (stack.ts), the same bearer verifier as everywhere
 * else in this stack. */
export const FAKE_MEDIA_HUB_ENV: Readonly<Record<string, string>> = {
  MEDIA_HUB_URL: `self:${FAKE_MEDIA_HUB_PATH}`,
};

/**
 * True when the stack runs, and points NoD at, its fake Media Hub: NoD has no effective
 * `MEDIA_HUB_URL` ("" counts as none) AND this is not a real production deployment -- same
 * safety net as {@link usesFakeFlickr} (NODE_ENV isn't "production", or it's a test deployment
 * via LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true). Production with no Media Hub configured fails
 * closed instead: no Media Hub at all, so search/add-from-hub answer 503 rather than serving
 * made-up contacts that could get added to a real media list.
 */
export function usesFakeMediaHub(env: NodeJS.ProcessEnv): boolean {
  if (env.NOD_MEDIA_HUB_URL) return false;
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true";
}

/** Where the stack mounts its fake emergency feed when NoD has no real one configured. */
export const FAKE_EMERGENCY_FEED_PATH = "/fake-emergency-feed";

/** What NoD's env view gets in fake mode: the fake's in-process feed URL. */
export const FAKE_EMERGENCY_FEED_ENV: Readonly<Record<string, string>> = {
  EMERGENCY_FEED_URL: `self:${FAKE_EMERGENCY_FEED_PATH}/feed.xml`,
};

/**
 * True when NoD reads the stack's fake emergency feed: no effective NOD_EMERGENCY_FEED_URL and
 * not a real production deployment (the same net as usesFakeMediaHub). Production with no URL
 * reads no feed at all rather than made-up alerts.
 */
export function usesFakeEmergencyFeed(env: NodeJS.ProcessEnv): boolean {
  if (env.NOD_EMERGENCY_FEED_URL) return false;
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true";
}

/** What NRMS's env view gets in fake mode: the fake's credentials and its in-process URLs. */
export const FAKE_FLICKR_ENV: Readonly<Record<string, string>> = {
  FLICKR_MODE: "fake",
  FLICKR_API_KEY: FAKE_FLICKR.apiKey,
  FLICKR_API_SECRET: FAKE_FLICKR.apiSecret,
  FLICKR_ACCESS_TOKEN: FAKE_FLICKR.accessToken,
  FLICKR_ACCESS_SECRET: FAKE_FLICKR.accessSecret,
  FLICKR_REST_URL: `self:${FAKE_FLICKR_PATH}/services/rest`,
  FLICKR_OEMBED_URL: `self:${FAKE_FLICKR_PATH}/services/oembed`,
  FLICKR_OAUTH_URL: `self:${FAKE_FLICKR_PATH}/services/oauth`,
};

/** NRMS's effective value of a FLICKR_* setting, as envFor resolves it: NRMS_<name> when it is
 * defined (even empty), else the shared <name>. */
function nrmsFlickrSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`NRMS_${name}`] !== undefined ? env[`NRMS_${name}`] : env[name];
}

/**
 * True when the stack runs, and points NRMS at, its fake Flickr: NRMS has no effective Flickr
 * key ("" counts as none) AND this is not a real production deployment — NODE_ENV isn't
 * "production", or it's a test deployment (LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true), or the fake
 * is asked for explicitly (FLICKR_MODE=fake). Production with a lost key fails closed instead:
 * no Flickr at all, so the publisher alerts and asset status reads "unavailable" — never the
 * fake's "this photo no longer exists" for a real photo.
 */
export function usesFakeFlickr(env: NodeJS.ProcessEnv): boolean {
  if (nrmsFlickrSetting(env, "FLICKR_API_KEY")) return false;
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || nrmsFlickrSetting(env, "FLICKR_MODE") === "fake";
}

/**
 * Shared vars every app's env view inherits unprefixed, verbatim: LOCAL_ADMIN_* (the whole
 * family), LOCAL_AUTH_SECRET, TENANT_CONFIG, NODE_ENV, (fix round 1, P2-R30 M6) ENTRA_TENANT_ID
 * — every app talks to the same Entra tenant, so that one is shared too — and (Task 6)
 * SESSION_SECRET / SESSION_COOKIE_SECURE, so every app verifies the same `gcpe_session` cookie
 * under the same security policy. AUTH_AUDIENCE is deliberately NOT shared: each app is its own
 * audience/resource in Entra (`<PREFIX>_AUTH_AUDIENCE`), same as it would be as six separate
 * deployments. DATA_DIR (Task 1) is shared too — the one folder, outside any SiteGround deploy
 * folder, that survives a redeploy (see data-dir.ts). SITE_ENVIRONMENT (plan 3d task 4) is
 * shared so an operator can mark a whole deployment (e.g. boxs.ca) a test site with one
 * setting, reaching Public Site's `isTestSite` the same way NODE_ENV/LOCAL_ADMIN_ALLOW_IN_PRODUCTION do.
 */
function isSharedKey(key: string): boolean {
  return (
    key === "NODE_ENV" ||
    key === "TENANT_CONFIG" ||
    key === "LOCAL_AUTH_SECRET" ||
    key === "ENTRA_TENANT_ID" ||
    key === "SESSION_SECRET" ||
    key === "SESSION_COOKIE_SECURE" ||
    key === "DATA_DIR" ||
    key === "SITE_ENVIRONMENT" ||
    key.startsWith("LOCAL_ADMIN_")
  );
}

/**
 * Builds the env view passed to one app's `start<App>(env)`: every shared var, plus every
 * `${prefix}_VAR` in `env` with the prefix stripped to `VAR` (e.g. `NRMS_DATABASE_URL` ->
 * `DATABASE_URL`). A prefixed var always wins over a shared one of the same name (applied
 * second, so it can override) — in practice the two sets don't collide since no app's own
 * schema uses a shared var's exact name for something else.
 *
 * `dataDir` (Task 1), when given, anchors the two app-specific defaults that must survive a
 * SiteGround redeploy: NRMS's `STORAGE_DIR` defaults to `<dataDir>/storage` (set alongside the
 * other STACK_APP_DEFAULTS, so an explicit `NRMS_STORAGE_DIR` still wins), and a *relative*
 * `SITE_OUTPUT_DIR` (e.g. the env generator's `./site-output`) resolves to `<dataDir>/<that
 * relative path>` — applied after the prefixed vars so it can see the raw, still-relative
 * `OUTPUT_DIR` value; an absolute `SITE_OUTPUT_DIR` is left untouched.
 */
export function envFor(env: NodeJS.ProcessEnv, prefix: AppPrefix, dataDir?: string): NodeJS.ProcessEnv {
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && isSharedKey(key)) view[key] = value;
  }
  // Derived internal wiring first, so explicit <PREFIX>_EVENT_* vars (applied below) override it.
  if (env.STACK_EVENT_SECRET) Object.assign(view, internalEventEnv(env.STACK_EVENT_SECRET, eventRoutesFor(env))[prefix]);
  if (!view.SESSION_SECRET && env.STACK_EVENT_SECRET) view.SESSION_SECRET = sessionSecretFrom(env.STACK_EVENT_SECRET);
  // Phase 4a: NoD's LINK_SECRET (HMAC key for unsubscribe tokens) needs no SiteGround setting
  // of its own — derived from the same stack secret as the session/event secrets above. An
  // explicit NOD_LINK_SECRET still wins (applied below, with every other prefixed var).
  if (prefix === "NOD" && !view.LINK_SECRET && env.STACK_EVENT_SECRET) view.LINK_SECRET = createHmac("sha256", env.STACK_EVENT_SECRET).update("gcpe-nod-links").digest("hex");
  // This app's built-in defaults, before its own prefixed vars so an explicit one still wins.
  if (STACK_APP_DEFAULTS[prefix]) Object.assign(view, STACK_APP_DEFAULTS[prefix]);
  if (dataDir && prefix === "NRMS") view.STORAGE_DIR = join(dataDir, "storage");
  // Flickr (Phase 3c) is NRMS's alone: an unprefixed FLICKR_* reaches NRMS only, and an
  // explicit NRMS_FLICKR_* (applied below) still wins over it.
  if (prefix === "NRMS") {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && key.startsWith("FLICKR_")) view[key] = value;
    }
  }
  const withUnderscore = `${prefix}_`;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith(withUnderscore)) view[key.slice(withUnderscore.length)] = value;
  }
  // No Flickr key at all → the stack's fake Flickr (see stack.ts), whatever else FLICKR_* says;
  // FLICKR_ALERT_EMAILS is left as configured.
  if (prefix === "NRMS" && usesFakeFlickr(env)) Object.assign(view, FAKE_FLICKR_ENV);
  // No Media Hub configured at all → the stack's fake Media Hub (see stack.ts).
  if (prefix === "NOD" && usesFakeMediaHub(env)) Object.assign(view, FAKE_MEDIA_HUB_ENV);
  if (prefix === "NOD" && usesFakeEmergencyFeed(env)) Object.assign(view, FAKE_EMERGENCY_FEED_ENV);
  if (dataDir && prefix === "SITE" && view.OUTPUT_DIR && !isAbsolute(view.OUTPUT_DIR)) {
    view.OUTPUT_DIR = join(dataDir, view.OUTPUT_DIR);
  }
  return view;
}

/**
 * The fixed in-process event topology of the stack: who publishes what to whom. Inside one
 * process this never varies by deployment, so the operator shouldn't have to spell it out.
 * Core and NRMS send every event type to the News API (it restricts by source itself); NoD
 * consumes release.published/updated/unpublished (NRMS: Phase 4b Task 2 — items.ts records
 * and refreshes/withdraws items from these, release.updated never sending), NRMS's
 * media_list.created/updated/deactivated (from NRMS's media-list admin API and importer, mirrored
 * by NoD so a release's media-list keys resolve to real NoD list keys) and Core's
 * taxonomy events (Phase 4a: its own `lists` mirror Core's ministries/sectors/themes/tags —
 * see apps/nod/src/lists.ts); the site builder
 * only site.rebuild_requested; NRMS also keeps its own local copy of Core's ministries and
 * categories, so it receives Core's org, sector, theme and tag upserted/deactivated events too
 * (Phase 3b task 3: taxonomy.ts).
 */
export const INTERNAL_EVENT_ROUTES = [
  { from: "CORE", source: "core", to: "NEWSAPI", name: "news-api", url: "self:/events", types: newsApiEventTypesFromCore() },
  {
    from: "CORE", source: "core", to: "NRMS", name: "nrms", url: "self:/nrms/events",
    types: ["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
  {
    from: "CORE", source: "core", to: "NOD", name: "nod", url: "self:/nod/events",
    types: ["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
  {
    // The Calendar's projections (spec addendum §4, §5.2). user.* goes here and nowhere public.
    from: "CORE", source: "core", to: "CALENDAR", name: "calendar", url: "self:/calendar/events",
    types: ["org.upserted", "org.deactivated", "user.upserted", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
  { from: "NRMS", source: "nrms", to: "NEWSAPI", name: "news-api", url: "self:/events", types: ["*"] },
  {
    from: "NRMS", source: "nrms", to: "NOD", name: "nod", url: "self:/nod/events",
    types: ["release.published", "release.updated", "release.unpublished", "media_list.created", "media_list.updated", "media_list.deactivated"],
  },
  { from: "NEWSAPI", source: "news-api", to: "SITE", name: "public-site", url: "self:/site-builder/events", types: ["site.rebuild_requested"] },
  // Phase 4e: Distribution's recorded bounces, back to the app that sent the original
  // message -- for now always NoD, the only sender wired up (apps/nod/src/bounces.ts records
  // the bounce and applies the 10-in-15-days rule; apps/nod/src/app.ts wires it in).
  { from: "DIST", source: "distribution", to: "NOD", name: "nod", url: "self:/nod/events", types: ["delivery.bounced"] },
] as const satisfies readonly { from: AppPrefix; source: string; to: AppPrefix; name: string; url: string; types: readonly string[] }[];

export type EventRoute = (typeof INTERNAL_EVENT_ROUTES)[number];

/** The routes this deployment wires: every route, less the Calendar's when it isn't configured. */
export function eventRoutesFor(env: NodeJS.ProcessEnv): readonly EventRoute[] {
  if (calendarConfigured(env)) return INTERNAL_EVENT_ROUTES;
  return INTERNAL_EVENT_ROUTES.filter((r) => (r.from as AppPrefix) !== "CALENDAR" && (r.to as AppPrefix) !== "CALENDAR");
}

/** Per-route signing secret: HMAC-SHA256(STACK_EVENT_SECRET, "gcpe-event:<source>-><receiver>"),
 * so every sender/receiver pair gets its own key and none of them is the stack secret itself. */
export function routeSecret(stackSecret: string, route: EventRoute): string {
  return createHmac("sha256", stackSecret).update(`gcpe-event:${route.source}->${route.name}`).digest("hex");
}

/** The staff session-cookie signing key (spec addendum §2), derived like the event secrets so a
 * SiteGround deployment needs no extra setting: HMAC-SHA256(STACK_EVENT_SECRET, "gcpe-session"). */
export function sessionSecretFrom(stackSecret: string): string {
  return createHmac("sha256", stackSecret).update("gcpe-session").digest("hex");
}

/** EVENT_SUBSCRIBERS (senders) and EVENT_SECRETS (receivers) for every app, derived from one secret. */
export function internalEventEnv(stackSecret: string, routes: readonly EventRoute[] = INTERNAL_EVENT_ROUTES): Record<AppPrefix, Record<string, string>> {
  const out = Object.fromEntries(APP_PREFIXES.map((p) => [p, {}])) as Record<AppPrefix, Record<string, string>>;
  const subscribers: Partial<Record<AppPrefix, { name: string; url: string; secret: string; types: string[] }[]>> = {};
  const secrets: Partial<Record<AppPrefix, Record<string, string>>> = {};
  for (const route of routes) {
    const secret = routeSecret(stackSecret, route);
    (subscribers[route.from] ??= []).push({ name: route.name, url: route.url, secret, types: [...route.types] });
    (secrets[route.to] ??= {})[route.source] = secret;
  }
  for (const prefix of APP_PREFIXES) {
    if (subscribers[prefix]) out[prefix].EVENT_SUBSCRIBERS = JSON.stringify(subscribers[prefix]);
    if (secrets[prefix]) out[prefix].EVENT_SECRETS = JSON.stringify(secrets[prefix]);
  }
  return out;
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
 * subscriber's `url` field starting with `self:/` becomes `http://stack.internal/rest` (routed in-process — see internal-fetch.ts)
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
export function resolveSelfSubscribers(value: string | undefined): string | undefined {
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
      return { ...item, url: `${INTERNAL_ORIGIN}${stripSelfPrefix(item.url)}` };
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
 *
 * Ruling P2-R32 (Task 14 re-review r1 residual): any var whose name ends in `DATABASE_URL`
 * (bare `DATABASE_URL` or a prefixed `<PREFIX>_DATABASE_URL`, which `envFor` has already
 * stripped to `DATABASE_URL` by the time it reaches here) is excluded from this rewrite even
 * though it also ends in `_URL` — a database is never reached over the stack's own loopback
 * HTTP port, so "resolving" a `self:/...` DATABASE_URL to `http://stack.internal/...` and
 * handing that straight to `pg` would just be the wrong fix dressed up as one. `DATABASE_URL`
 * must simply never be set to `self:/` (the env generator and runbook never produce that);
 * left untouched here, a mistaken one still fails loudly as an invalid Postgres connection
 * string, the same way any other typo'd DATABASE_URL would.
 */
export function resolveSelfUrls(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "EVENT_SUBSCRIBERS") {
      view[key] = resolveSelfSubscribers(value)!;
    } else if (key.endsWith("_URL") && !key.endsWith("DATABASE_URL") && isSelfUrl(value)) {
      view[key] = `${INTERNAL_ORIGIN}${stripSelfPrefix(value)}`;
    } else {
      view[key] = value;
    }
  }
  return view;
}
