import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";

export const calendarMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createCalendarTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: calendarMigrations });
}
