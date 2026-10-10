// Shared Calendar list fixture for calendar-list.spec.ts and axe-sweep.spec.ts: six activities on
// one day, covering every branch of the visibility rule (spec addendum §6). Setup runs as the HQ
// Administrator, who is exempt from the 4pm-5pm freeze, so it works at any hour.
import type { BrowserContext } from "@playwright/test";
import { CAL_ADMIN_EMAIL, CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_READONLY_EMAIL, CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, loginForCookie, tick } from "./playwright-support";

export type Key = "A" | "B" | "C" | "D" | "E" | "F";
export interface ListFixture {
  tag: string;
  ids: Record<Key, number>;
  category: number;
  city: number;
  /** Comm contact ids: the Calendar Editor for Health, the Read Only user for Finance. */
  health: number;
  finance: number;
}

/** The fixture's day; MAY is its month. */
export const FIXTURE_DAY = "2031-05-14";
export const MAY = { from: "2031-05-01", to: "2031-05-31" };

/** A seeded user's session, minted by global-setup (never a real login: the login limiter allows 10 a minute). */
export const sessionOf = (email: string) => loginForCookie(email, TEST_USER_PASSWORDS[email]!);

export async function useCookie(context: BrowserContext, cookie: string): Promise<void> {
  await context.clearCookies();
  const [name, value] = cookie.split("=", 2) as [string, string];
  await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}

/** `/hub/calendar` with this list query in `?q=`, plus any further parameters. */
export const listUrl = (q: object, extra = "") => `${baseUrl()}/hub/calendar?q=${encodeURIComponent(JSON.stringify(q))}${extra}`;

export function activityInput(
  f: Pick<ListFixture, "category" | "city">,
  o: { title: string; ministry: "health" | "finance"; contact: number; time: string; date?: string; confidential?: boolean; shared?: string[] },
) {
  const date = o.date ?? FIXTURE_DAY;
  return {
    categoryId: f.category, title: o.title, details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: o.confidential ?? false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
    startDate: date, startTime: o.time, endDate: date, endTime: `${String(Number(o.time.slice(0, 2)) + 1).padStart(2, "0")}:00`, nrDate: null, nrTime: null,
    contactMinistryKey: o.ministry, commContactId: o.contact, governmentRepresentativeId: null, cityId: f.city, premierRequestedId: null,
    nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: o.shared ?? [], translations: [],
  };
}

let cached: ListFixture | null = null;

/**
 * Six activities on FIXTURE_DAY, titled "Vis <key> <tag>": A Health, B Health confidential,
 * C Finance, D Finance confidential, E Finance confidential shared with Health, F Health deleted.
 * Created once per worker process.
 */
export async function listFixture(): Promise<ListFixture> {
  if (cached) return cached;
  // Carries Core's users and grants to the Calendar, as the first tick of a fresh stack does.
  await tick();
  const stamp = Date.now();
  const tag = `vis${stamp}`;
  const sys = await sessionOf(CAL_SYSADMIN_EMAIL);
  const admin = await sessionOf(CAL_ADMIN_EMAIL);
  const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
  const editorId = (await apiCall<{ userId: string }>(await sessionOf(CAL_EDITOR_EMAIL), "/calendar/api/me")).userId;
  const readOnlyId = (await apiCall<{ userId: string }>(await sessionOf(CAL_READONLY_EMAIL), "/calendar/api/me")).userId;
  await apiCall(admin, `/calendar/api/users/${editorId}/comm-contacts/health`, { method: "PUT", body: { rank: 4 } });
  await apiCall(hq, `/calendar/api/users/${readOnlyId}/comm-contacts/finance`, { method: "PUT", body: { rank: 4 } });
  // Not Awareness (2, hidden until a filter names it) and not a release category (12, 58).
  let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E list category ${stamp}` } });
  while ([2, 12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E list category ${stamp}-${category.id}` } });
  const city = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/cities", { method: "POST", body: { name: `E2E list city ${stamp}` } });
  const contacts = await apiCall<{ id: number; label: string }[]>(hq, "/calendar/api/transfer/comm-contacts");
  const contact = (label: string) => {
    const found = contacts.find((c) => c.label === label);
    if (!found) throw new Error(`no comm contact labelled ${label}`);
    return found.id;
  };
  const health = contact("Test Calendar Editor (HLTH)");
  const finance = contact("Test Calendar Read Only (FIN)");
  const f = { category: category.id, city: city.id };
  const make = async (key: Key, o: { ministry: "health" | "finance"; time: string; confidential?: boolean; shared?: string[] }) =>
    (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body: activityInput(f, { ...o, title: `Vis ${key} ${tag}`, contact: o.ministry === "health" ? health : finance }) })).id;
  const ids: Record<Key, number> = {
    A: await make("A", { ministry: "health", time: "09:00" }),
    B: await make("B", { ministry: "health", time: "10:00", confidential: true }),
    C: await make("C", { ministry: "finance", time: "11:00" }),
    D: await make("D", { ministry: "finance", time: "12:00", confidential: true }),
    E: await make("E", { ministry: "finance", time: "13:00", confidential: true, shared: ["health"] }),
    F: await make("F", { ministry: "health", time: "14:00" }),
  };
  const view = await apiCall<{ version: number }>(hq, `/calendar/api/activities/${ids.F}`);
  await apiCall(hq, `/calendar/api/activities/${ids.F}`, { method: "DELETE", body: { version: view.version } });
  cached = { tag, ids, ...f, health, finance };
  return cached;
}
