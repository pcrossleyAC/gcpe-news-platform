import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { organizations, userOrganizations, users } from "../db/schema";
import {
  AbbreviationTakenError,
  HQ_ABBREVIATIONS,
  createOrganization,
  deactivateOrganization,
  getOrganization,
  isHqAbbreviation,
  isNonPublicAbbreviation,
  listOrganizations,
  orgProfilePatchSchema,
  patchOrganizationProfile,
  setOrganizationHq,
  setOrganizationPublic,
  SuccessionError,
  succeedOrganization,
  successionPreview,
  upsertOrganization,
  type SuccessionInput,
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

  describe("succession (new-government spec §4)", () => {
    const all: Omit<SuccessionInput, "successorKeys"> = { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true };
    const org = (key: string, displayName: string, abbreviation: string | null, extra: Partial<typeof healthOrg> = {}) =>
      upsertOrganization(tdb.db, { ...healthOrg, key, displayName, abbreviation, ...extra }, subs);
    const orgId = async (key: string) => (await tdb.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.key, key)))[0]!.id;
    async function user(email: string, ...orgKeys: string[]): Promise<string> {
      const [u] = await tdb.db.insert(users).values({ email, displayName: email }).returning({ id: users.id });
      for (const k of orgKeys) await tdb.db.insert(userOrganizations).values({ userId: u!.id, organizationId: await orgId(k) });
      return u!.id;
    }
    async function memberships(): Promise<string[]> {
      const { rows } = await tdb.pool.query<{ m: string }>(
        "SELECT u.email || ':' || o.key AS m FROM user_organizations uo JOIN users u ON u.id = uo.user_id JOIN organizations o ON o.id = uo.organization_id ORDER BY 1",
      );
      return rows.map((r) => r.m);
    }
    /**
     * Every outbox row, grouped by aggregate and in each aggregate's sequence order: the outbox has no
     * global order column (random ids, one created_at per transaction), and consumers order per aggregate.
     */
    async function outbox(): Promise<{ type: string; aggregateId: string; data: Record<string, unknown> }[]> {
      const { rows } = await tdb.pool.query<{ type: string; aggregate_id: string; envelope: { data: Record<string, unknown> } }>(
        "SELECT type, aggregate_id, envelope FROM outbox_events ORDER BY aggregate_id, sequence",
      );
      return rows.map((r) => ({ type: r.type, aggregateId: r.aggregate_id, data: r.envelope.data }));
    }
    const clearOutbox = () => tdb.pool.query("TRUNCATE outbox_events, aggregate_sequences CASCADE");
    beforeEach(async () => {
      await tdb.pool.query("TRUNCATE users CASCADE");
    });

    it("hands over: A inactive with successorKeys, staff moved without duplicates, events in order", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", null);
      const onlyA = await user("only-a@example.test", "a");
      const both = await user("both@example.test", "a", "b");
      await user("bystander@example.test", "b");
      await clearOutbox();

      const record = await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      expect(record).toMatchObject({ key: "a", isActive: false, successorKeys: ["b"], abbreviation: "ALPH" });
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: ["b"] });
      expect((await getOrganization(tdb.db, "b"))!.abbreviation).toBe("ALPH");
      expect(await memberships()).toEqual(["both@example.test:b", "bystander@example.test:b", "only-a@example.test:b"]);
      // The seed and importer must not bring A back.
      const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "a"));
      expect(row!.staffEditedAt).toBeInstanceOf(Date);

      const events = await outbox();
      expect(events.map((e) => `${e.type} ${e.aggregateId}`)).toEqual([
        "org.upserted org:a",
        "org.deactivated org:a",
        "org.upserted org:b",
        "org.succeeded org-succession:a",
        ...[onlyA, both].sort().map((id) => `user.upserted user:${id}`),
      ]);
      expect(events[0]!.data).toMatchObject({ key: "a", isActive: false, successorKeys: ["b"] });
      expect(events[2]!.data).toMatchObject({ key: "b", abbreviation: "ALPH", successorKeys: [] });
      expect(events[3]!.data).toEqual({ key: "a", successorKeys: ["b"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true, at: expect.any(String) });
      for (const e of events.slice(4)) expect(e.data.organizationKeys).toEqual(["b"]);
    });

    it("B keeps its own abbreviation without takeAbbreviation; no org.upserted for B", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", "BETA");
      await clearOutbox();
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all, takeAbbreviation: false }, subs);
      expect((await getOrganization(tdb.db, "b"))!.abbreviation).toBe("BETA");
      expect((await outbox()).map((e) => `${e.type} ${e.aggregateId}`)).toEqual(["org.upserted org:a", "org.deactivated org:a", "org.succeeded org-succession:a"]);
    });

    it("a split keeps the successor order; staff go to the first", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await org("c", "Gamma", null);
      await user("u@example.test", "a");
      const record = await succeedOrganization(tdb.db, "a", { successorKeys: ["c", "b", "c"], ...all }, subs);
      expect(record!.successorKeys).toEqual(["c", "b"]);
      expect(await memberships()).toEqual(["u@example.test:c"]);
    });

    it("abbreviation can be taken from an inactive ministry but not an active one", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", "BETA");
      await org("c", "Gamma", "GAMA");
      // Active C holds GAMA: B may not take it.
      const taken = await patchOrganizationProfile(tdb.db, "b", { abbreviation: "GAMA" }, subs).catch((e: unknown) => e);
      expect(taken).toBeInstanceOf(AbbreviationTakenError);
      expect((taken as AbbreviationTakenError).takenBy).toBe("Gamma");
      // Once C is inactive, its abbreviation is free for B.
      await deactivateOrganization(tdb.db, "c", subs);
      expect((await patchOrganizationProfile(tdb.db, "b", { abbreviation: "GAMA" }, subs))!.abbreviation).toBe("GAMA");
      // A hand-over takes A's abbreviation: A is inactive by then.
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      expect((await getOrganization(tdb.db, "b"))!.abbreviation).toBe("ALPH");
    });

    it("a hand-over refuses A's abbreviation while another active ministry holds it, and writes nothing", async () => {
      await org("a", "Alpha", "DUP");
      await org("b", "Beta", "BETA");
      await org("d", "Delta", "dup ");
      await user("u@example.test", "a");
      await clearOutbox();
      const err = await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AbbreviationTakenError);
      expect((err as AbbreviationTakenError).takenBy).toBe("Delta");
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: true, successorKeys: [] });
      expect(await memberships()).toEqual(["u@example.test:a"]);
      expect(await outbox()).toEqual([]);
    });

    it("refuses a cycle", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await tdb.pool.query("UPDATE organizations SET successor_keys = '{a}' WHERE key = 'b'");
      const err = await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SuccessionError);
      expect((err as Error).message).toBe("Beta already leads back to Alpha; that would loop.");
      expect((await getOrganization(tdb.db, "a"))!.isActive).toBe(true);
    });

    it("refuses a longer cycle through an inactive ministry", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await org("c", "Gamma", null, { isActive: false });
      await tdb.pool.query("UPDATE organizations SET successor_keys = '{c}' WHERE key = 'b'");
      await tdb.pool.query("UPDATE organizations SET successor_keys = '{a}' WHERE key = 'c'");
      const err = await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs).catch((e: unknown) => e);
      expect((err as Error).message).toBe("Beta already leads back to Alpha; that would loop.");
    });

    it("refuses itself, an unknown or inactive successor, or none, with the copy", async () => {
      await org("a", "Alpha", null);
      await org("old", "Old", null, { isActive: false });
      const refused = (keys: string[]) => succeedOrganization(tdb.db, "a", { successorKeys: keys, ...all }, subs).catch((e: unknown) => e);
      for (const [keys, message] of [
        [["a"], "A ministry can't succeed itself."],
        [["nope"], "Choose an active ministry as successor."],
        [["old"], "Choose an active ministry as successor."],
        [[], "Choose an active ministry as successor."],
      ] as const) {
        const err = await refused([...keys]);
        expect(err, keys.join()).toBeInstanceOf(SuccessionError);
        expect((err as Error).message).toBe(message);
      }
      expect((await getOrganization(tdb.db, "a"))!.isActive).toBe(true);
    });

    it("returns null for an unknown ministry", async () => {
      await org("b", "Beta", null);
      expect(await succeedOrganization(tdb.db, "nope", { successorKeys: ["b"], ...all }, subs)).toBeNull();
    });

    it("works on an already-inactive A: no org.deactivated again, but successorKeys are set and org.succeeded is emitted", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await deactivateOrganization(tdb.db, "a", subs);
      await clearOutbox();
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      expect((await getOrganization(tdb.db, "a"))!.successorKeys).toEqual(["b"]);
      expect((await outbox()).map((e) => e.type)).toEqual(["org.upserted", "org.succeeded"]);
      // The same hand-over again changes nothing on A but still re-sends org.succeeded (handlers are idempotent).
      await clearOutbox();
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      expect((await outbox()).map((e) => e.type)).toEqual(["org.succeeded"]);
    });

    it("moveStaff false leaves user_organizations alone", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await user("u@example.test", "a");
      await clearOutbox();
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all, moveStaff: false }, subs);
      expect(await memberships()).toEqual(["u@example.test:a"]);
      expect((await outbox()).some((e) => e.type === "user.upserted")).toBe(false);
    });

    it("event flags follow the input; takeAbbreviation is false when A has none to give", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", "BETA");
      await clearOutbox();
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], moveSubscribers: false, moveStaff: false, moveCalendar: true, moveDrafts: false, takeAbbreviation: true }, subs);
      const ev = (await outbox()).find((e) => e.type === "org.succeeded")!;
      expect(ev.data).toMatchObject({ moveSubscribers: false, moveCalendar: true, moveDrafts: false, takeAbbreviation: false });
      expect((await getOrganization(tdb.db, "b"))!.abbreviation).toBe("BETA");
    });

    it("uses the caller's transaction when given one, so a later failure rolls the hand-over back", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await tdb.db
        .transaction(async (tx) => {
          await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs, tx);
          throw new Error("later op failed");
        })
        .catch(() => undefined);
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: true, successorKeys: [] });
    });

    it("reactivating clears successorKeys", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      await clearOutbox();
      const record = await patchOrganizationProfile(tdb.db, "a", { isActive: true }, subs);
      expect(record).toMatchObject({ isActive: true, successorKeys: [] });
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: true, successorKeys: [] });
      expect((await outbox()).map((e) => [e.type, e.data.successorKeys])).toEqual([["org.upserted", []]]);
    });

    it("reactivating A is refused while its successor uses A's abbreviation", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", null);
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      const err = await patchOrganizationProfile(tdb.db, "a", { isActive: true }, subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AbbreviationTakenError);
      expect((err as AbbreviationTakenError).takenBy).toBe("Beta");
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: ["b"] });
      // Giving A a new abbreviation in the same save is fine.
      expect(await patchOrganizationProfile(tdb.db, "a", { isActive: true, abbreviation: "ALPH2" }, subs)).toMatchObject({ isActive: true, abbreviation: "ALPH2", successorKeys: [] });
    });

    it("a re-seed or re-import that omits successorKeys keeps them; a forced reactivating PUT clears them", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      const inactive = { ...healthOrg, key: "a", displayName: "Alpha", abbreviation: null, isActive: false };
      await upsertOrganization(tdb.db, { ...inactive, displayName: "Alpha (renamed)" }, subs);
      expect((await getOrganization(tdb.db, "a"))!.successorKeys).toEqual(["b"]);
      await upsertOrganization(tdb.db, { ...inactive, isActive: true }, subs);
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: true, successorKeys: [] });
    });

    it("A→B, then B→A by mistake, is refused: A is no longer an active ministry", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      const err = await succeedOrganization(tdb.db, "b", { successorKeys: ["a"], ...all }, subs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SuccessionError);
      expect((err as Error).message).toBe("Choose an active ministry as successor.");
      expect(await getOrganization(tdb.db, "b")).toMatchObject({ isActive: true, successorKeys: [] });
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: ["b"] });
    });

    it("A→B, then B→C, chains: A keeps [b], B points at c, staff end on C", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", null);
      await org("c", "Gamma", null);
      await user("u@example.test", "a");
      await succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
      await succeedOrganization(tdb.db, "b", { successorKeys: ["c"], ...all }, subs);
      expect(await getOrganization(tdb.db, "a")).toMatchObject({ isActive: false, successorKeys: ["b"] });
      expect(await getOrganization(tdb.db, "b")).toMatchObject({ isActive: false, successorKeys: ["c"] });
      expect(await getOrganization(tdb.db, "c")).toMatchObject({ isActive: true, successorKeys: [], abbreviation: "ALPH" });
      expect(await memberships()).toEqual(["u@example.test:c"]);
    });

    it("moves only staff still on A once their locks are held (a removal racing the hand-over isn't undone)", async () => {
      await org("a", "Alpha", null);
      await org("b", "Beta", null);
      const leaving = await user("leaving@example.test", "a");
      await user("staying@example.test", "a");
      const holder = await tdb.pool.connect();
      try {
        // An admin edit of `leaving` holds that user's lock and removes them from A meanwhile.
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user:${leaving}`]);
        const pending = succeedOrganization(tdb.db, "a", { successorKeys: ["b"], ...all }, subs);
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          const w = await tdb.pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
          if (w.rowCount) waiting = true;
          else await new Promise((r) => setTimeout(r, 10));
        }
        expect(waiting).toBe(true);
        await holder.query("DELETE FROM user_organizations WHERE user_id = $1", [leaving]);
        await holder.query("COMMIT");
        await pending;
      } finally {
        holder.release();
      }
      expect(await memberships()).toEqual(["staying@example.test:b"]);
    });

    it("successionPreview counts A's staff and names its abbreviation", async () => {
      await org("a", "Alpha", "ALPH");
      await org("b", "Beta", null);
      await user("one@example.test", "a");
      await user("two@example.test", "a", "b");
      await user("three@example.test", "b");
      expect(await successionPreview(tdb.db, "a")).toEqual({ staff: 2, abbreviation: "ALPH" });
      expect(await successionPreview(tdb.db, "b")).toEqual({ staff: 2, abbreviation: null });
    });
  });
});
