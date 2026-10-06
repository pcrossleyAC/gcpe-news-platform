// Shared helpers for the Playwright acceptance suite (task-6-brief.md). Every spec imports from
// here instead of re-deriving the same login/seed/tick/axe plumbing.
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDb, type Db } from "@gcpe/db-kit";
export { headlineOf } from "../../apps/staff-web/src/screens/release/viewHelpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME, SESSION_COOKIE, TEST_USER_PASSWORDS, TICK_TOKEN } from "./constants";
import { sampleCreate } from "../../apps/nrms/test/helpers";
import type { CreateReleaseInput, ReleaseView } from "@gcpe/nrms-contract";

/** Set by tests/e2e/global-setup.ts before any worker process is forked — see its own comment
 * for why that env var is visible here even though this file runs in a separate worker process. */
export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL is not set — tests/e2e/global-setup.ts must run first (it does, under `npm run test:e2e`).");
  return url;
}

const CSRF_HEADER = "X-GCPE-Request";

export interface SessionCookie {
  /** The raw `name=value` pair, exactly as `addSessionCookie` needs it. */
  cookie: string;
}

const cookieCache = new Map<string, string>();

/** `POST /core/auth/login` directly (no browser) — faster than driving the sign-in form for
 * every spec that doesn't specifically need to exercise the form itself (acceptance item 1
 * covers that once, in sign-in.spec.ts). Returns the raw session cookie value.
 *
 * Cached per username for the whole run: `/core/auth/login` sits behind a combined, stack-wide
 * 10/min/IP rate limit (apps/stack/src/stack.ts's `combinedLoginLimiter`, covering every app's
 * login route) — this suite's many specs sharing one worker/one IP would otherwise blow through
 * that budget in seconds. The session cookie is valid for an hour (SESSION_TTL_SECONDS), far
 * longer than this whole suite runs, so one real login per user is always enough. */
export async function loginForCookie(username: string, password: string): Promise<string> {
  const cached = cookieCache.get(username);
  if (cached) return cached;
  const res = await fetch(`${baseUrl()}/core/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login for ${username} failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!setCookie) throw new Error(`no ${SESSION_COOKIE} cookie in login response`);
  const cookie = setCookie.split(";")[0]!;
  cookieCache.set(username, cookie);
  return cookie;
}

export const ROLE_LOGINS = {
  admin: () => loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD),
  editor: () => loginForCookie("editor@example.test", TEST_USER_PASSWORDS["editor@example.test"]!),
  siteEditor: () => loginForCookie("site-editor@example.test", TEST_USER_PASSWORDS["site-editor@example.test"]!),
  viewer: () => loginForCookie("viewer@example.test", TEST_USER_PASSWORDS["viewer@example.test"]!),
} as const;
export type Role = keyof typeof ROLE_LOGINS;

/** Installs a session cookie into a fresh browser context — the "sign in via the API and set
 * the cookie" shortcut the brief allows for every spec except the one that must drive the
 * sign-in form itself. Call before the first `page.goto`. */
export async function signInAs(context: BrowserContext, role: Role): Promise<void> {
  const cookie = await ROLE_LOGINS[role]();
  const [name, value] = cookie.split("=", 2) as [string, string];
  const url = new URL(baseUrl());
  await context.addCookies([{ name, value, domain: url.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}

/** A same-origin JSON call against the stack, outside the browser — used to seed state
 * (creating/approving/scheduling releases, etc.) faster than driving every step through the UI.
 * Mirrors apps/staff-web/src/api/client.ts's apiFetch contract closely enough for test setup. */
export async function apiCall<T = unknown>(
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { cookie, ...init.headers };
  if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = "1";
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl()}${path}`, { method, headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data as T;
}

/** A minimal valid 1x1 PNG — reused wherever a test just needs *some* real image bytes
 * (I6's axe-sweep seeding; website.spec.ts's own upload test builds the same bytes inline). */
export const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

/** `POST /nrms/api/site/files?name=&replace=` with raw bytes — `apiCall` always JSON-encodes
 * its body, which this route doesn't take (apps/nrms/src/http/site-routes.ts's `rawFile`
 * middleware reads the raw request body). Used to seed a Website file outside the browser. */
export async function uploadSiteFile(cookie: string, name: string, bytes: Buffer, contentType = "image/png"): Promise<{ id: string; url: string }> {
  const res = await fetch(`${baseUrl()}/nrms/api/site/files?${new URLSearchParams({ name, replace: "false" })}`, {
    method: "POST",
    headers: { cookie, [CSRF_HEADER]: "1", "content-type": contentType },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`uploadSiteFile(${name}) -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ id: string; url: string }>;
}

/** `POST /stack/tick` (the publisher/dispatch worker run) — apps/stack/src/stack.ts. */
export async function tick(): Promise<void> {
  const res = await fetch(`${baseUrl()}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_TOKEN}` } });
  if (res.status !== 200 && res.status !== 202) throw new Error(`tick failed: ${res.status}`);
}

/** Ticks twice, same hedge as apps/stack/src/stack.test.ts's Phase 2 exit check ("call the tick
 * twice if needed") — the publisher and the News API/site-builder dispatch can need a second
 * pass to fully settle a freshly-published release. */
export async function tickTwice(): Promise<void> {
  await tick();
  await tick();
}

/** Creates a release as `editor` through the API (not the UI) with a full, publishable body —
 * headline, organizations, location, body text and a contact — one ministry/sector. Used to
 * seed state for specs that aren't themselves testing the creation form (item 2 covers that). */
export async function createPublishableRelease(editorCookie: string, over: Partial<CreateReleaseInput> = {}): Promise<ReleaseView> {
  const input: CreateReleaseInput = {
    ...sampleCreate,
    headline: `${sampleCreate.headline} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...over,
  };
  return apiCall<ReleaseView>(editorCookie, "/nrms/api/releases", { method: "POST", body: input });
}

export async function approveRelease(editorCookie: string, view: ReleaseView): Promise<ReleaseView> {
  return apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${view.id}/approve`, { method: "POST", body: { version: view.version } });
}

export async function publishNow(editorCookie: string, view: ReleaseView): Promise<ReleaseView> {
  return apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${view.id}/schedule`, { method: "POST", body: { version: view.version, publishAt: "now" } });
}

/** Creates, approves and publishes (now) a release in one call — the common "I just need a
 * published release to look at" setup. */
export async function createApprovedAndPublished(editorCookie: string, over: Partial<CreateReleaseInput> = {}): Promise<ReleaseView> {
  const created = await createPublishableRelease(editorCookie, over);
  const approved = await approveRelease(editorCookie, created);
  const published = await publishNow(editorCookie, approved);
  await tickTwice();
  return apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${published.id}`);
}

/**
 * React Aria's Modal plays a CSS enter transition (opacity/colour) when it opens. axe-core
 * samples *live* computed style — caught mid-transition, a perfectly fine design renders as a
 * wildly different (and non-deterministic, run to run) near-invisible colour-contrast
 * "violation": confirmed by re-running the same dialog-open axe check repeatedly and seeing a
 * different nonsense foreground/background pair reported each time. Call this right after a
 * dialog becomes visible and before running axe (or any other check that reads real computed
 * colour) on it.
 */
export async function settleModalTransition(page: Page): Promise<void> {
  await page.waitForTimeout(350);
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** Runs axe-core against the current page (task-6-brief.md item 16: every staff screen, no
 * serious/critical violations). Returns the violations so a caller can also assert specifics;
 * always asserts the serious/critical gate itself. */
export async function expectNoSeriousA11yViolations(page: Page, context?: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (blocking.length > 0) {
    const detail = blocking
      .map((v) => `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s): ${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)
      .join("\n");
    expect(blocking, `${context ?? "page"} has serious/critical axe violations:\n${detail}`).toEqual([]);
  }
}

/**
 * Drives a raw HTML5 drag between two draggable elements the way the Documents/Carousel/Links
 * sections implement reorder (plain `draggable` divs with their own onDragStart/onDragOver/
 * onDrop, no library). Not Playwright's built-in `locator.dragTo()`: that drives pointer events
 * only, and Chromium's native HTML5 drag protocol needs its own drag events carrying a real
 * `DataTransfer` — confirmed by trying `dragTo` here first and finding the drop had no effect
 * at all. `page.evaluateHandle` builds the one `DataTransfer` object in the browser; the same
 * handle is reused across all three events, exactly like a real drag gesture reuses one.
 */
export async function dragReorder(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

const TENANT_TIME_ZONE = "America/Vancouver";

/** `date`'s BC wall-clock date/time, as `{date: "YYYY-MM-DD", time: "HH:mm"}` — the exact shape
 * the SchedulePicker inputs and `publishAtLocal`/`goLiveAtLocal` take. Used to schedule "a
 * minute from now" without waiting minutes (task-6-brief.md's time-dependent-items guidance). */
export function bcLocalParts(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TENANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/**
 * The wall-clock instant (real ms since epoch) at which the *next* BC-local minute boundary
 * after `from` begins — i.e. what `bcLocalParts(new Date(from.getTime() + 60_000))` names.
 *
 * I6 (minute-boundary flake): callers compute this once, then spend real time driving the UI
 * (filling in the date/time, saving, ...) before the deadline is actually supposed to matter —
 * if that boundary was less than 15s away to begin with, the UI steps alone can eat into or
 * past it, making "not due yet" assertions flaky. Skip to the *following* minute whenever the
 * nearest one is that close, so every caller always gets at least 15s of real headroom.
 */
export function nextMinuteBoundaryMs(from: Date): number {
  const nearest = Math.ceil((from.getTime() + 1) / 60_000) * 60_000;
  return nearest - from.getTime() < 15_000 ? nearest + 60_000 : nearest;
}

export function uniqueHeadline(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let cachedNrmsDb: Db | undefined;

/** A direct connection to the same NRMS test database the running stack uses — item 9's Flickr
 * outage spec uses this to fast-forward a Flickr job's `first_attempt_at` past its real 2-minute
 * grace period (apps/nrms/src/media/flickr-jobs.ts's GRACE_MS) instead of sleeping two minutes;
 * there is no test-clock hook for it in the stack itself. See global-setup.ts's
 * `E2E_NRMS_DATABASE_URL`. */
export function nrmsDb(): Db {
  if (!cachedNrmsDb) {
    const url = process.env.E2E_NRMS_DATABASE_URL;
    if (!url) throw new Error("E2E_NRMS_DATABASE_URL is not set — tests/e2e/global-setup.ts must run first.");
    cachedNrmsDb = createDb(url, { max: 2 }).db;
  }
  return cachedNrmsDb;
}

export interface SentMessage {
  subject: string | null;
  to: string[];
  text: string | null;
  attachmentNames: string[];
  /** Every header the sink received, lowercased keys (mailparser's own `Map` normalises header
   * names to lower case), string values — used to check `List-Unsubscribe`/
   * `List-Unsubscribe-Post` on a subscriber send. */
  headers: Record<string, string>;
}

/** Reads back every message the SMTP sink has received so far — see global-setup.ts's
 * `mailInspector` for why this goes over HTTP rather than a shared in-memory array. */
export async function fetchSentMessages(): Promise<SentMessage[]> {
  const url = process.env.E2E_MAIL_INSPECT_URL;
  if (!url) throw new Error("E2E_MAIL_INSPECT_URL is not set — tests/e2e/global-setup.ts must run first.");
  const res = await fetch(url);
  return (await res.json()) as SentMessage[];
}

/** Polls the SMTP sink until a message with this exact subject shows up (publish is driven by
 * `tick()`, which is itself synchronous by the time it returns, but mail delivery inside that
 * tick can still be a beat behind in CI). */
export async function waitForMessageWithSubject(subject: string, timeoutMs = 10_000): Promise<SentMessage> {
  const start = Date.now();
  for (;;) {
    const messages = await fetchSentMessages();
    const found = messages.find((m) => m.subject === subject);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`no message with subject ${JSON.stringify(subject)} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** `POST /nod/api/subscribers` — a NoD subscriber on a ministry list, for item 5's "publish now
 * -> ... -> NoD email" chain. Tolerates 409 (a prior test's subscriber row surviving, same hedge
 * apps/stack/src/stack.test.ts uses). */
export async function ensureSubscriber(adminCookie: string, email: string, lists: string[]): Promise<void> {
  const res = await fetch(`${baseUrl()}/nod/api/subscribers`, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER]: "1", cookie: adminCookie },
    body: JSON.stringify({ email, lists }),
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`subscriber creation failed: ${res.status} ${await res.text()}`);
}
