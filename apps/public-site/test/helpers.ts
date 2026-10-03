import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";

export const publicSiteMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createPublicSiteTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: publicSiteMigrations });
}
