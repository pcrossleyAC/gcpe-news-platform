/**
 * Phase 3e (NRMS legacy importer, spec §8, task 2): legacy `dbo.User` rows become inactive
 * Core users, matched by email. An email that already belongs to an active Core user is
 * reused as is — the import never touches an existing user's roles, active flag or name, so
 * staff who already have real Core accounts keep them untouched. A brand-new email becomes a
 * new user with no roles and no password, created inactive (legacy accounts have no business
 * being able to sign in).
 *
 * Fix round 1: every candidate is run through `createUserSchema` (not just passed straight to
 * `createUser`), so legacy's looser data gets the same trimming/length rules real sign-ups
 * get: the display name is trimmed and truncated to 100 chars, falling back to the email's
 * local part when legacy left it blank; a row whose email doesn't pass schema validation (or
 * is empty, or a case-insensitive duplicate of one already processed in this batch) is skipped
 * and returned with a reason, rather than silently dropped, so the caller can report it.
 */
import type { Db } from "@gcpe/db-kit";
import { createUser, createUserSchema, findUserByEmail } from "../services/users";

export interface LegacyUserRow {
  email: string;
  displayName: string;
}

export interface SkippedLegacyUser {
  email: string;
  displayName: string;
  reason: string;
}

export interface ImportLegacyUsersResult {
  users: Map<string, { id: string; displayName: string }>;
  skipped: SkippedLegacyUser[];
}

export async function importLegacyUsers(db: Db, rows: LegacyUserRow[]): Promise<ImportLegacyUsersResult> {
  const users = new Map<string, { id: string; displayName: string }>();
  const skipped: SkippedLegacyUser[] = [];

  for (const row of rows) {
    const rawEmail = row.email.trim();
    if (!rawEmail) {
      skipped.push({ email: row.email, displayName: row.displayName, reason: "empty email" });
      continue;
    }

    const emailLower = rawEmail.toLowerCase();
    if (users.has(emailLower)) {
      skipped.push({ email: row.email, displayName: row.displayName, reason: "duplicate email" });
      continue;
    }

    const trimmedName = row.displayName.trim();
    const localPart = emailLower.split("@")[0] ?? emailLower;
    const displayName = (trimmedName || localPart).slice(0, 100);

    const parsed = createUserSchema.safeParse({ email: emailLower, displayName, roles: [], isActive: false });
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => i.message).join("; ") || "invalid user data";
      skipped.push({ email: row.email, displayName: row.displayName, reason });
      continue;
    }

    // emailLower is already the trimmed, lowercased address createUserSchema would produce;
    // used here (rather than parsed.data.email) because the schema's email is nullable for
    // the no-email import case, and this row always has one.
    const existing = await findUserByEmail(db, emailLower);
    if (existing) {
      users.set(emailLower, { id: existing.id, displayName: existing.displayName });
      continue;
    }

    // Imported staff are inactive with no roles, so they grant no Calendar access; Core's republish carries them to subscribers.
    const created = await createUser(db, parsed.data, []);
    users.set(emailLower, { id: created.id, displayName: created.displayName });
  }

  return { users, skipped };
}
