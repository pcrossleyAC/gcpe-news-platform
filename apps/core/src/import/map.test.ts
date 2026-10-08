import { describe, expect, it } from "vitest";
import { mapMinistry, mapTerm, type LegacyMinistryRow } from "./map";

// Values from gcpe-hub-develop/db-scripts/gcpe.hub-data-01-dbo.sql (GCPE Media Relations row)
const mediaRelations: LegacyMinistryRow = {
  Id: "768dbf29-89c6-48d1-901e-017a8a3557a4",
  Key: "768DBF29-89C6-48D1-901E-017A8A3557A4",
  SortOrder: 190,
  DisplayName: "GCPE Media Relations",
  Abbreviation: "GCPEMEDIA",
  IsActive: true,
  MinisterEmail: "",
  MinisterPhotoUrl: "",
  MinisterPageHtml: "",
  MinisterAddress: "",
  MinisterName: "",
  MinisterSummary: "",
  MinistryUrl: null,
  ParentKey: null,
  WeekendContactNumber: "",
  DisplayAdditionalName: "",
  TwitterUsername: "",
  FlickrUrl: "",
  YoutubeUrl: "",
  AudioUrl: "",
  ContactFullName: null,
  ContactPhone: null,
  ContactMobile: null,
  ContactEmail: null,
  ContactUserId: null,
  SecondContactFullName: null,
  SecondContactPhone: null,
  SecondContactMobile: null,
  SecondContactEmail: null,
  SecondContactUserId: null,
};

describe("mapMinistry", () => {
  it("carries empty strings and NULLs verbatim", () => {
    const org = mapMinistry(mediaRelations, { topics: [], services: [], sectorKeys: [] });
    expect(org).toEqual({
      key: "768DBF29-89C6-48D1-901E-017A8A3557A4",
      displayName: "GCPE Media Relations",
      abbreviation: "GCPEMEDIA",
      sortOrder: 190,
      isActive: true,
      parentKey: null,
      url: null,
      displayAdditionalName: "",
      minister: { name: "", summary: "", detailsHtml: "", email: "", photoUrl: "", address: "" },
      contact: null,
      secondContact: null,
      weekendContactNumber: "",
      social: { twitterUsername: "", flickrUrl: "", youtubeUrl: "", audioUrl: "" },
      topicLinks: [],
      serviceLinks: [],
      sectorKeys: [],
      isHq: true,
    });
  });

  it("maps contacts, parent, and links ordered by SortIndex", () => {
    const org = mapMinistry(
      { ...mediaRelations, Key: "health", ParentKey: "office-of-the-premier", ContactUserId: 7, ContactFullName: "Alex Example", ContactPhone: "250-555-0100", ContactMobile: "250-555-0100", ContactEmail: "alex.example@gov.bc.ca" },
      {
        topics: [
          { MinistryId: mediaRelations.Id, SortIndex: 2, LinkText: "Second", LinkUrl: "https://b" },
          { MinistryId: mediaRelations.Id, SortIndex: 1, LinkText: "First", LinkUrl: "https://a" },
        ],
        services: [],
        sectorKeys: ["health"],
      },
    );
    expect(org.parentKey).toBe("office-of-the-premier");
    expect(org.contact).toEqual({ fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" });
    expect(org.topicLinks).toEqual([{ text: "First", url: "https://a" }, { text: "Second", url: "https://b" }]);
    expect(org.sectorKeys).toEqual(["health"]);
  });

  it("maps a dangling ContactUserId (no matching SystemUser) to a null contact", () => {
    const org = mapMinistry(
      { ...mediaRelations, ContactUserId: 99, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null },
      { topics: [], services: [], sectorKeys: [] },
    );
    expect(org.contact).toBeNull();
  });

  it("marks GCPEHQ, GCPEMEDIA and PREM as HQ and leaves every other ministry's flag to Core (Q49)", () => {
    const related = { topics: [], services: [], sectorKeys: [] };
    expect(mapMinistry({ ...mediaRelations, Abbreviation: "GCPEHQ" }, related).isHq).toBe(true);
    expect(mapMinistry({ ...mediaRelations, Abbreviation: "GCPEMEDIA" }, related).isHq).toBe(true);
    expect(mapMinistry({ ...mediaRelations, Key: "office-of-the-premier", Abbreviation: "PREM" }, related).isHq).toBe(true);
    expect("isHq" in mapMinistry({ ...mediaRelations, Abbreviation: "HLTH" }, related)).toBe(false);
  });
});

describe("mapTerm", () => {
  // gcpe.hub-data-01-dbo.sql Sector row
  it("maps a sector with its English name fallback", () => {
    expect(
      mapTerm("sector", { Id: "1b1c7a5e-0000-0000-0000-000000000001", Key: "government-operations", SortOrder: 0, IsActive: true, DisplayName: null, EnglishName: "Government Operations", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "" }),
    ).toEqual({
      kind: "sector",
      key: "government-operations",
      displayName: "Government Operations",
      sortOrder: 0,
      isActive: true,
      social: { twitterUsername: "", flickrUrl: "", youtubeUrl: "", audioUrl: "" },
    });
  });

  it("maps a theme without social columns to null social fields", () => {
    expect(mapTerm("theme", { Id: "1b1c7a5e-0000-0000-0000-000000000002", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health" }).social).toEqual({
      twitterUsername: null,
      flickrUrl: null,
      youtubeUrl: null,
      audioUrl: null,
    });
  });
});
