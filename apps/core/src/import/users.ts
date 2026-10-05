/**
 * Phase 3e (NRMS legacy importer, spec §8, task 2): legacy `dbo.User` rows become inactive
 * Core users, matched by email. An email that already belongs to an active Core user is
 * reused as is — the import never touches an existing user's roles, active flag or name, so
 * staff who already have real Core accounts keep them untouched. A brand-new email becomes a
 * new user with no roles and no password, created inactive (legacy accounts have no business
 * being able to sign in). Rows with an empty email, or a duplicate of an email already seen in
 * this same batch, are skipped — the caller (the NRMS importer's reporting) counts them.
 */
import type { Db } from "@gcpe/db-kit";
import { createUser, findUserByEmail } from "../services/users";

export interface LegacyUserRow {
  email: string;
  displayName: string;
}

export async function importLegacyUsers(db: Db, rows: LegacyUserRow[]): Promise<Map<string, { id: string; displayName: string }>> {
  const result = new Map<string, { id: string; displayName: string }>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email || result.has(email)) continue;

    const existing = await findUserByEmail(db, email);
    if (existing) {
      result.set(email, { id: existing.id, displayName: existing.displayName });
      continue;
    }

    const created = await createUser(db, { email, displayName: row.displayName, roles: [], isActive: false });
    result.set(email, { id: created.id, displayName: created.displayName });
  }
  return result;
}
