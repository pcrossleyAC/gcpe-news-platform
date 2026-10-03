import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { OrgInput } from "../src/services/organizations";

export const coreMigrations = new URL("../migrations", import.meta.url).pathname;

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
  minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>bio</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/immunize" }],
  serviceLinks: [],
  sectorKeys: ["health"],
};
