import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { OrgInput } from "../src/services/organizations";
import { fileURLToPath } from "node:url";

export const coreMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createCoreTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: coreMigrations });
}

export const healthOrg: OrgInput = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", detailsHtml: "<p>bio</p>", email: "SP.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/immunize" }],
  serviceLinks: [],
  sectorKeys: ["health"],
  isPublic: true,
};
