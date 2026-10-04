import type { Db } from "@gcpe/db-kit";
import { createUser, createUserSchema, findUserByEmail, setPassword, setPasswordSchema, setRoles, updateUser } from "./users";

/** The three local test users (spec addendum §2). Fictional addresses on the reserved .test TLD. */
export const TEST_USERS = [
  { email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"] },
  { email: "site-editor@example.test", displayName: "Test Site Editor", roles: ["NRMS.SiteEditor"] },
  { email: "viewer@example.test", displayName: "Test Viewer", roles: ["NRMS.Viewer"] },
] as const;

/** Creates the test users, or resets an existing one's roles and password and reactivates it. */
export async function seedTestUsers(db: Db, passwords: Record<string, string>): Promise<{ email: string; action: "created" | "updated" }[]> {
  for (const u of TEST_USERS) setPasswordSchema.parse({ password: passwords[u.email] ?? "" });
  const out: { email: string; action: "created" | "updated" }[] = [];
  for (const u of TEST_USERS) {
    const password = passwords[u.email]!;
    const existing = await findUserByEmail(db, u.email);
    if (!existing) {
      await createUser(db, createUserSchema.parse({ email: u.email, displayName: u.displayName, roles: [...u.roles], password }));
      out.push({ email: u.email, action: "created" });
      continue;
    }
    await setRoles(db, existing.id, [...u.roles]);
    await setPassword(db, existing.id, password);
    await updateUser(db, existing.id, { isActive: true, displayName: u.displayName });
    out.push({ email: u.email, action: "updated" });
  }
  return out;
}
