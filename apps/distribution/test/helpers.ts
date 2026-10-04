import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { MessageRequest } from "../src/messages";

export const distributionMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
export const createDistributionTestDb = (): Promise<TestDatabase> => createTestDatabase({ migrationsFolder: distributionMigrations });

export const sampleMessageRequest: MessageRequest = {
  priority: "immediate",
  subject: "Weekend clinics open across B.C.",
  html: "<p>Hi {{name}}, clinics are open.</p>",
  text: "Hi {{name}}, clinics are open.",
  headers: {},
  attachments: [],
  recipients: [
    { email: "alex.example@gov.bc.ca", substitutions: { name: "Alex" } },
    { email: "sam.example@example.com", substitutions: { name: "Sam" } },
  ],
};
