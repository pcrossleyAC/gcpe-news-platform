import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import {
  AbbreviationTakenError,
  HQ_ABBREVIATIONS,
  createOrganization,
  deactivateOrganization,
  getOrganization,
  isHqAbbreviation,
  isNonPublicAbbreviation,
  listOrganizations,
  MAX_BIO_CHARS,
  orgProfilePatchSchema,
  patchOrganizationProfile,
  setOrganizationHq,
  setOrganizationPublic,
  upsertOrganization,
} from "./organizations";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];

describe("organizations service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, outbox_events, aggregate_sequences CASCADE");
  });

  it("inserts, returns the record, and emits org.upserted", async () => {
    const { record, changed } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(changed).toBe(true);
    expect(record).toMatchObject(healthOrg);
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"));
    expect(events.map((e) => e.type)).toEqual(["org.upserted"]);
    expect((events[0]!.envelope as { data: unknown }).data).toEqual(record);
  });

  it("does not emit when nothing changed", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
  });

  it("emits again when a field changes", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
    expect((await getOrganization(tdb.db, "health"))!.displayName).toBe("Health and Wellness");
  });

  it("deactivates and emits org.deactivated; unknown key returns false", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    expect((await getOrganization(tdb.db, "health"))!.isActive).toBe(false);
    expect(await deactivateOrganization(tdb.db, "nope", subs)).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.deactivated"]);
  });

  it("lists by sort order then key", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "b", sortOrder: 1 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "a", sortOrder: 2 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "c", sortOrder: 1 }, subs);
    expect((await listOrganizations(tdb.db)).map((o) => o.key)).toEqual(["b", "c", "a"]);
  });

  it("concurrent upserts of a brand-new key emit exactly once and preserve legacyId", async () => {
    const legacyId = "11111111-1111-1111-1111-111111111111";
    await Promise.all([
      upsertOrganization(tdb.db, { ...healthOrg, key: "concurrent" }, subs, { legacyId }),
      upsertOrganization(tdb.db, { ...healthOrg, key: "concurrent" }, subs),
    ]);
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:concurrent"));
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'concurrent'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("deactivating an already-inactive org is idempotent", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.deactivated"]);
  });

  it("sets legacyId on an unchanged later call without emitting a second event", async () => {
    const legacyId = "11111111-1111-1111-1111-111111111111";
    await upsertOrganization(tdb.db, healthOrg, subs);
    const second = await upsertOrganization(tdb.db, healthOrg, subs, { legacyId });
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'health'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("preserves legacyId when a later unchanged call omits it", async () => {
    const legacyId = "22222222-2222-2222-2222-222222222222";
    await upsertOrganization(tdb.db, healthOrg, subs, { legacyId });
    const second = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'health'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("an organization is not HQ until set; org.upserted carries the flag", async () => {
    const { record } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(record.isHq).toBe(false);
    const hq = await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", abbreviation: "GCPEHQ", isHq: true }, subs);
    expect(hq.record.isHq).toBe(true);
    const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:gcpe-headquarters"));
    expect((event!.envelope as { data: { isHq: boolean } }).data.isHq).toBe(true);
  });

  it("an upsert that omits isHq keeps the stored flag and emits nothing new", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, isHq: true }, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    expect(again.record.isHq).toBe(true);
    const renamed = await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(renamed.record.isHq).toBe(true);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
  });

  it("isHqOnCreate sets the flag only when the upsert creates the organization; an explicit isHq still wins (C124)", async () => {
    expect((await upsertOrganization(tdb.db, healthOrg, subs, { isHqOnCreate: true })).record.isHq).toBe(true);
    await setOrganizationHq(tdb.db, "health", false, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs, { isHqOnCreate: true });
    expect(again).toMatchObject({ changed: false, record: { isHq: false } });
    expect((await upsertOrganization(tdb.db, { ...healthOrg, isHq: true }, subs, { isHqOnCreate: false })).record.isHq).toBe(true);
  });

  it("setOrganizationHq flips the flag and emits once; the same value emits nothing; an unknown key is null", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", false, subs))!.isHq).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"))).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.upserted", "org.upserted"]);
    expect(await setOrganizationHq(tdb.db, "no-such-org", true, subs)).toBeNull();
  });

  it("HQ abbreviations are GCPEHQ, GCPEMEDIA and PREM, matched trimmed and in any case (Q49)", () => {
    expect([...HQ_ABBREVIATIONS]).toEqual(["GCPEHQ", "GCPEMEDIA", "PREM"]);
    expect(isHqAbbreviation(" gcpemedia ")).toBe(true);
    expect(isHqAbbreviation("GCPEHQ")).toBe(true);
    expect(isHqAbbreviation("prem")).toBe(true);
    expect(isHqAbbreviation("HLTH")).toBe(false);
    expect(isHqAbbreviation("PREMX")).toBe(false);
    expect(isHqAbbreviation(null)).toBe(false);
  });

  describe("isPublic (Q54)", () => {
    it("a new organization is public unless told otherwise; isPublicOnCreate applies only on create", async () => {
      const created = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-a" }, []);
      expect(created.record.isPublic).toBe(true);
      const gcpe = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ" }, [], { isPublicOnCreate: false });
      expect(gcpe.record.isPublic).toBe(false);
      // An existing organization keeps its flag whatever isPublicOnCreate says.
      await setOrganizationPublic(tdb.db, "pub-b", true, []);
      const again = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ", displayName: "Renamed" }, [], { isPublicOnCreate: false });
      expect(again.record.isPublic).toBe(true);
    });

    it("an upsert that omits isPublic keeps the stored flag; one that sends it sets it", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c" }, []);
      await setOrganizationPublic(tdb.db, "pub-c", false, []);
      expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", displayName: "Renamed" }, [])).record.isPublic).toBe(false);
      expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", isPublic: true }, [])).record.isPublic).toBe(true);
    });

    it("setOrganizationPublic emits org.upserted only on a change, and 404s an unknown key", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-d" }, []);
      const subs: SubscriberConfig[] = [{ name: "x", url: "http://x/events", secret: "s", types: ["org.upserted"] }];
      const before = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length;
      expect((await setOrganizationPublic(tdb.db, "pub-d", true, subs))!.isPublic).toBe(true);
      expect((await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length).toBe(before);
      expect((await setOrganizationPublic(tdb.db, "pub-d", false, subs))!.isPublic).toBe(false);
      const after = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"));
      expect(after.length).toBe(before + 1);
      expect((after.at(-1)!.envelope as { data: OrgRecord }).data.isPublic).toBe(false);
      expect(await setOrganizationPublic(tdb.db, "no-such-org", false, subs)).toBeNull();
    });

    it("isNonPublicAbbreviation matches GCPEHQ and GCPEMEDIA, trimmed and case-insensitive, and not PREM", () => {
      expect(isNonPublicAbbreviation(" gcpehq ")).toBe(true);
      expect(isNonPublicAbbreviation("GCPEMEDIA")).toBe(true);
      expect(isNonPublicAbbreviation("PREM")).toBe(false);
      expect(isNonPublicAbbreviation(null)).toBe(false);
    });
  });

  describe("ministry page links (side column)", () => {
    const orgEvents = async (key: string) =>
      (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `org:${key}`))).map((e) => e.envelope as { type: string; data: OrgRecord });

    it("PATCH topicLinks replaces the list in order, stamps staffEditedAt and emits org.upserted carrying it", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      const links = [
        { text: "Mental health", url: "https://www2.gov.bc.ca/mental-health" },
        { text: "Contact us", url: "/contact" },
      ];
      const record = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ topicLinks: links }), subs);
      expect(record!.topicLinks).toEqual(links);
      const events = await orgEvents("health");
      expect(events).toHaveLength(2);
      expect(events[1]!.data.topicLinks).toEqual(links);
      const { rows } = await tdb.pool.query("SELECT staff_edited_at FROM organizations WHERE key = 'health'");
      expect(rows[0].staff_edited_at).toBeInstanceOf(Date);
    });

    it("trims link text and addresses", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      const record = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ serviceLinks: [{ text: " Apply ", url: " https://x.gov.bc.ca/a " }] }), subs);
      expect(record!.serviceLinks).toEqual([{ text: "Apply", url: "https://x.gov.bc.ca/a" }]);
    });

    it("social.flickrUrl merges without clearing twitterUsername or audioUrl", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, social: { twitterUsername: "BCGovNews", flickrUrl: null, youtubeUrl: null, audioUrl: "https://audio.example/a" } }, subs);
      const record = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ social: { flickrUrl: "https://www.flickr.com/photos/bcgovphotos" } }), subs);
      expect(record!.social).toEqual({ twitterUsername: "BCGovNews", flickrUrl: "https://www.flickr.com/photos/bcgovphotos", youtubeUrl: null, audioUrl: "https://audio.example/a" });
    });

    it("the website, photos and videos addresses must be absolute https; blank clears", () => {
      expect(orgProfilePatchSchema.safeParse({ url: "http://gov.bc.ca/health" }).success).toBe(false);
      expect(orgProfilePatchSchema.safeParse({ url: "/health" }).success).toBe(false);
      expect(orgProfilePatchSchema.safeParse({ social: { youtubeUrl: "javascript:alert(1)" } }).success).toBe(false);
      expect(orgProfilePatchSchema.safeParse({ social: { twitterUsername: "x" } }).success).toBe(false);
      expect(orgProfilePatchSchema.parse({ url: " https://gov.bc.ca/health ", social: { flickrUrl: "  " } })).toEqual({ url: "https://gov.bc.ca/health", social: { flickrUrl: null } });
    });

    it("links follow the safe-URL rule, need text, and number at most 20 per list", () => {
      const bad = orgProfilePatchSchema.safeParse({ topicLinks: [{ text: "ok", url: "https://a.ca" }, { text: "x", url: "http://x.ca" }] });
      expect(bad.success).toBe(false);
      expect(bad.error!.issues).toEqual([expect.objectContaining({ path: ["topicLinks", 1, "url"], message: "Must start with https:// or / (a page on this site)." })]);
      const blank = orgProfilePatchSchema.safeParse({ serviceLinks: [{ text: "  ", url: "/a" }] });
      expect(blank.error!.issues).toEqual([expect.objectContaining({ path: ["serviceLinks", 0, "text"], message: "Enter the link text." })]);
      const many = Array.from({ length: 21 }, (_, i) => ({ text: `L${i}`, url: `/p${i}` }));
      expect(orgProfilePatchSchema.safeParse({ topicLinks: many }).success).toBe(false);
      expect(orgProfilePatchSchema.safeParse({ topicLinks: many.slice(0, 20) }).success).toBe(true);
    });
  });

  describe("biography, Meet the Team links and media contacts (T1, T2)", () => {
    const orgEvents = async (key: string) =>
      (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `org:${key}`))).map((e) => e.envelope as { type: string; data: OrgRecord });
    const patch = (body: unknown) => patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse(body), subs);
    const issues = (body: unknown) => orgProfilePatchSchema.safeParse(body).error?.issues.map((i) => ({ path: i.path, message: i.message }));

    it("PATCH minister.detailsHtml stores the sanitised HTML and emits one org.upserted", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      const record = await patch({ minister: { detailsHtml: ' <p onclick="x()">Pat <b>Doe</b></p><script>alert(1)</script><p></p> ' } });
      expect(record!.minister.detailsHtml).toBe("<p>Pat <strong>Doe</strong></p>");
      expect(record!.minister.name).toBe(healthOrg.minister.name);
      expect((await getOrganization(tdb.db, "health"))!.minister.detailsHtml).toBe("<p>Pat <strong>Doe</strong></p>");
      const events = await orgEvents("health");
      expect(events).toHaveLength(2);
      expect(events[1]!.data.minister.detailsHtml).toBe("<p>Pat <strong>Doe</strong></p>");
    });

    it("PATCH detailsHtml '<p></p>' or '<p> </p>' stores null", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      expect((await patch({ minister: { detailsHtml: "<p></p>" } }))!.minister.detailsHtml).toBeNull();
      await upsertOrganization(tdb.db, healthOrg, subs);
      expect((await patch({ minister: { detailsHtml: "<p> </p>" } }))!.minister.detailsHtml).toBeNull();
      for (const blank of ["<div> <br> </div>", "<script>x</script>", "   "]) {
        expect(orgProfilePatchSchema.parse({ minister: { detailsHtml: blank } })).toEqual({ minister: { detailsHtml: null } });
      }
    });

    it("a sanitised biography over 20,000 characters is refused on minister.detailsHtml", () => {
      const para = (n: number) => `<p>${"a".repeat(n - 7)}</p>`;
      expect(orgProfilePatchSchema.parse({ minister: { detailsHtml: para(MAX_BIO_CHARS) } }).minister!.detailsHtml).toHaveLength(MAX_BIO_CHARS);
      expect(issues({ minister: { detailsHtml: para(MAX_BIO_CHARS + 1) } })).toEqual([{ path: ["minister", "detailsHtml"], message: "Keep the biography to 20,000 characters or fewer." }]);
      // Measured after sanitising: markup that sanitising removes does not count.
      const padded = para(MAX_BIO_CHARS) + `<span style="${"x".repeat(5_000)}"></span>`;
      expect(orgProfilePatchSchema.parse({ minister: { detailsHtml: padded } }).minister!.detailsHtml).toHaveLength(MAX_BIO_CHARS);
      // The raw input is capped before sanitising.
      expect(orgProfilePatchSchema.safeParse({ minister: { detailsHtml: " ".repeat(100_001) } }).success).toBe(false);
    });

    it("PATCH teamLinks replaces the list; an unsafe url is refused on teamLinks[0].url", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      expect((await getOrganization(tdb.db, "health"))!.teamLinks).toEqual([]);
      const first = [
        { text: " Premier ", url: " /office-of-the-premier/biography " },
        { text: "Cabinet", url: "https://www2.gov.bc.ca/cabinet" },
      ];
      expect((await patch({ teamLinks: first }))!.teamLinks).toEqual([
        { text: "Premier", url: "/office-of-the-premier/biography" },
        { text: "Cabinet", url: "https://www2.gov.bc.ca/cabinet" },
      ]);
      const record = await patch({ teamLinks: [{ text: "Only", url: "/only" }] });
      expect(record!.teamLinks).toEqual([{ text: "Only", url: "/only" }]);
      expect((await orgEvents("health")).at(-1)!.data.teamLinks).toEqual([{ text: "Only", url: "/only" }]);
      expect(issues({ teamLinks: [{ text: "x", url: "javascript:alert(1)" }] })).toEqual([{ path: ["teamLinks", 0, "url"], message: "Must start with https:// or / (a page on this site)." }]);
      expect(issues({ teamLinks: [{ text: " ", url: "/a" }] })).toEqual([{ path: ["teamLinks", 0, "text"], message: "Enter the link text." }]);
      const many = Array.from({ length: 21 }, (_, i) => ({ text: `L${i}`, url: `/p${i}` }));
      expect(issues({ teamLinks: many })).toEqual([{ path: ["teamLinks"], message: "Use 20 links or fewer." }]);
    });

    it("PATCH contact sets all four fields; a contact of four blanks stores null; a bad email is refused on contact.emailAddress", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      const contact = { fullName: " Jo Media ", phoneNumber: " 250 555-0199 ", mobileNumber: "", emailAddress: " jo.media@gov.bc.ca " };
      const record = await patch({ contact, secondContact: { ...contact, fullName: "Second" } });
      expect(record!.contact).toEqual({ fullName: "Jo Media", phoneNumber: "250 555-0199", mobileNumber: null, emailAddress: "jo.media@gov.bc.ca" });
      expect(record!.secondContact).toEqual({ fullName: "Second", phoneNumber: "250 555-0199", mobileNumber: null, emailAddress: "jo.media@gov.bc.ca" });
      // Replaced whole, not merged field by field.
      const replaced = await patch({ contact: { fullName: "New", phoneNumber: null, mobileNumber: null, emailAddress: null } });
      expect(replaced!.contact).toEqual({ fullName: "New", phoneNumber: null, mobileNumber: null, emailAddress: null });
      expect(replaced!.secondContact!.fullName).toBe("Second");
      const cleared = await patch({ contact: { fullName: " ", phoneNumber: "", mobileNumber: null, emailAddress: "  " }, secondContact: null });
      expect(cleared!.contact).toBeNull();
      expect(cleared!.secondContact).toBeNull();
      expect(issues({ contact: { ...contact, emailAddress: "not-an-email" } })).toEqual([{ path: ["contact", "emailAddress"], message: "Enter an email address like name@gov.bc.ca." }]);
      expect(issues({ secondContact: { ...contact, mobileNumber: "1".repeat(51) } })).toEqual([{ path: ["secondContact", "mobileNumber"], message: "Keep phone numbers to 50 characters or fewer." }]);
      expect(orgProfilePatchSchema.safeParse({ contact: { ...contact, title: "Director" } }).success).toBe(false);
      expect(orgProfilePatchSchema.safeParse({ contact: { fullName: "Only a name" } }).success).toBe(false);
    });

    it("PATCH weekendContactNumber trims and stores; '' stores null", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      expect((await patch({ weekendContactNumber: " 250 555-0100 " }))!.weekendContactNumber).toBe("250 555-0100");
      expect((await patch({ weekendContactNumber: "" }))!.weekendContactNumber).toBeNull();
      expect(issues({ weekendContactNumber: "1".repeat(51) })).toEqual([{ path: ["weekendContactNumber"], message: "Keep phone numbers to 50 characters or fewer." }]);
    });

    it("an importer upsert that omits teamLinks on a row whose team_links is [] is not a change (no event)", async () => {
      expect("teamLinks" in healthOrg).toBe(false);
      await upsertOrganization(tdb.db, healthOrg, subs);
      const { rows } = await tdb.pool.query("SELECT team_links FROM organizations WHERE key = 'health'");
      expect(rows[0].team_links).toEqual([]);
      const again = await upsertOrganization(tdb.db, healthOrg, subs);
      expect(again.changed).toBe(false);
      expect(await orgEvents("health")).toHaveLength(1);
      // An explicit [] is the same content too; a non-empty list is a change.
      expect((await upsertOrganization(tdb.db, { ...healthOrg, teamLinks: [] }, subs)).changed).toBe(false);
      expect((await upsertOrganization(tdb.db, { ...healthOrg, teamLinks: [{ text: "a", url: "/a" }] }, subs)).changed).toBe(true);
    });
  });

  describe("abbreviation", () => {
    const MESSAGE = "Use 2 to 10 capital letters or digits, e.g. HLTH.";

    it("is trimmed and upper-cased; 1 character, 11 characters or punctuation is refused with the message", () => {
      expect(orgProfilePatchSchema.parse({ abbreviation: " hlth " })).toEqual({ abbreviation: "HLTH" });
      for (const bad of ["H", "HEALTH-1", "ABCDEFGHIJK", "", "HL TH"]) {
        const r = orgProfilePatchSchema.safeParse({ abbreviation: bad });
        expect(r.success, bad).toBe(false);
        expect(r.error!.issues[0]!.message).toBe(MESSAGE);
      }
    });

    it("PATCH stores it upper-case and emits org.upserted with it", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, abbreviation: null }, subs);
      const record = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ abbreviation: "hlth" }), subs);
      expect(record!.abbreviation).toBe("HLTH");
      const [, ev] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"));
      expect((ev!.envelope as { data: OrgRecord }).data.abbreviation).toBe("HLTH");
    });

    it("another organization's abbreviation, in any case, is refused naming that organization", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "fin" }, subs);
      await upsertOrganization(tdb.db, { ...healthOrg, abbreviation: "HLTH" }, subs);
      const err = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ abbreviation: "FIN" }), subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AbbreviationTakenError);
      expect((err as AbbreviationTakenError).takenBy).toBe("Finance");
      expect((await getOrganization(tdb.db, "health"))!.abbreviation).toBe("HLTH");
    });

    it("re-sending the organization's own abbreviation is not a conflict", async () => {
      await upsertOrganization(tdb.db, healthOrg, subs);
      const record = await patchOrganizationProfile(tdb.db, "health", orgProfilePatchSchema.parse({ abbreviation: "hlth" }), subs);
      expect(record!.abbreviation).toBe("HLTH");
    });

    it("two organizations claiming one abbreviation at once: exactly one wins", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "a", displayName: "A", abbreviation: null }, subs);
      await upsertOrganization(tdb.db, { ...healthOrg, key: "b", displayName: "B", abbreviation: null }, subs);
      const results = await Promise.allSettled([
        patchOrganizationProfile(tdb.db, "a", { abbreviation: "SAME" }, subs),
        patchOrganizationProfile(tdb.db, "b", { abbreviation: "SAME" }, subs),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(AbbreviationTakenError);
      const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM organizations WHERE abbreviation = 'SAME'");
      expect(rows[0].n).toBe(1);
    });

    it("create stores a given abbreviation upper-case, null when omitted, and refuses a taken one", async () => {
      const created = await createOrganization(tdb.db, { displayName: "Mining", abbreviation: "MCM" }, subs);
      expect("record" in created && created.record.abbreviation).toBe("MCM");
      const none = await createOrganization(tdb.db, { displayName: "Energy" }, subs);
      expect("record" in none && none.record.abbreviation).toBeNull();
      const err = await createOrganization(tdb.db, { displayName: "Mines Again", abbreviation: "mcm" }, subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AbbreviationTakenError);
      expect((err as AbbreviationTakenError).takenBy).toBe("Mining");
      expect(await getOrganization(tdb.db, "mines-again")).toBeNull();
    });
  });
});
