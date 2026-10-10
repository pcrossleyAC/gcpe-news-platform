import type { Db } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import { createUser, createUserSchema, findUserByEmail, setPassword, setPasswordSchema, setRoles, updateUser } from "./users";
import { setCalendarAccess } from "./calendar-access";
import { getOrganization } from "./organizations";

export interface TestUser {
  email: string;
  displayName: string;
  roles: readonly string[];
  /** Calendar access, given only when every organization exists and is active (they come from the seed or a test). */
  calendar?: { role: CalendarRole; organizationKeys: readonly string[] };
}

/** The local test users (spec addendum §2; NoD parity spec §10 item 14; Calendar spec addendum §4).
 * Fictional addresses on the reserved .test TLD. */
export const TEST_USERS: readonly TestUser[] = [
  { email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"] },
  { email: "site-editor@example.test", displayName: "Test Site Editor", roles: ["NRMS.SiteEditor"] },
  { email: "viewer@example.test", displayName: "Test Viewer", roles: ["NRMS.Viewer"] },
  { email: "nod-viewer@example.test", displayName: "Test NoD Viewer", roles: ["NoD.Viewer"] },
  { email: "nod-editor@example.test", displayName: "Test NoD Editor", roles: ["NoD.Editor"] },
  { email: "cal-admin@example.test", displayName: "Test Calendar Administrator", roles: [], calendar: { role: "Calendar.Administrator", organizationKeys: ["health"] } },
  { email: "cal-sysadmin@example.test", displayName: "Test Calendar System Administrator", roles: [], calendar: { role: "Calendar.SysAdmin", organizationKeys: ["health"] } },
  { email: "cal-hq-admin@example.test", displayName: "Test Calendar HQ Administrator", roles: [], calendar: { role: "Calendar.Administrator", organizationKeys: ["gcpe-headquarters"] } },
  { email: "cal-editor@example.test", displayName: "Test Calendar Editor", roles: [], calendar: { role: "Calendar.Editor", organizationKeys: ["health"] } },
  { email: "cal-readonly@example.test", displayName: "Test Calendar Read Only", roles: [], calendar: { role: "Calendar.ReadOnly", organizationKeys: ["finance"] } },
];

/** The seed CLI's prompt for one user's password, naming what the user will hold. */
export function passwordPrompt(u: TestUser): string {
  const holds = [...u.roles, ...(u.calendar ? [`${u.calendar.role}: ${u.calendar.organizationKeys.join(", ")}`] : [])];
  return `Password for ${u.email} (${holds.join(", ") || "no roles"}; input hidden): `;
}

export interface SeedResult {
  email: string;
  action: "created" | "updated";
  calendar?: "set" | "skipped";
  missingOrganizations?: string[];
}

/** Creates the test users, or resets an existing one's roles and password and reactivates it.
 * A user with a Calendar entry also gets Calendar access, skipped (and reported) if any of its
 * organizations doesn't exist yet (the seed runs before a stack has created any) or is inactive. */
export async function seedTestUsers(db: Db, passwords: Record<string, string>): Promise<SeedResult[]> {
  for (const u of TEST_USERS) setPasswordSchema.parse({ password: passwords[u.email] ?? "" });
  const out: SeedResult[] = [];
  // The seed CLI has no subscriber config. Core's republish carries seeded users to subscribers.
  for (const u of TEST_USERS) {
    const password = passwords[u.email]!;
    const existing = await findUserByEmail(db, u.email);
    let id: string;
    let result: SeedResult;
    if (!existing) {
      const created = await createUser(db, createUserSchema.parse({ email: u.email, displayName: u.displayName, roles: [...u.roles], password }), []);
      id = created.id;
      result = { email: u.email, action: "created" };
    } else {
      await setRoles(db, existing.id, [...u.roles], []);
      await setPassword(db, existing.id, password);
      await updateUser(db, existing.id, { isActive: true, displayName: u.displayName }, []);
      id = existing.id;
      result = { email: u.email, action: "updated" };
    }
    if (u.calendar) {
      const missing: string[] = [];
      for (const k of u.calendar.organizationKeys) {
        const o = await getOrganization(db, k);
        if (!o || !o.isActive) missing.push(k);
      }
      if (missing.length) {
        result.calendar = "skipped";
        result.missingOrganizations = missing;
      } else {
        // The seed acts as a Core admin; Core's republish carries the grant to the Calendar.
        await setCalendarAccess(db, { id: "seed", roles: ["Core.Admin"] }, id, { role: u.calendar.role, organizationKeys: [...u.calendar.organizationKeys] }, []);
        result.calendar = "set";
      }
    }
    out.push(result);
  }
  return out;
}
