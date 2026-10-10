// The BC seed and the legacy importer assert HQ and public only when they create an organization
// (C124, Calendar spec addendum Q49; Q54). On an existing organization neither touches isHq or
// isPublic in either direction, so Core.Admin's choice survives any re-seed or re-import. These
// tests run the real seed run() over HTTP against a real Core app and database, and the real
// importer against the same database.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource } from "@gcpe/legacy-import";
import { createApp } from "../apps/core/src/app";
import { importLegacyReference } from "../apps/core/src/import/run";
import { getOrganization, setOrganizationHq, setOrganizationPublic } from "../apps/core/src/services/organizations";
import { createCoreTestDb } from "../apps/core/test/helpers";
import type { PublicMinistry, PublicPost } from "../scripts/lib/public-taxonomy";
import { run } from "../scripts/seed-core-from-public-api";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://core";

const PREMIER: PublicMinistry = { key: "office-of-the-premier", name: "Office of the Premier", isActive: true };
const AEST: PublicMinistry = { key: "aest", name: "Ministry of Advanced Education", isActive: true };
const PREMIER_RELEASES: PublicPost[] = [{ key: "2026PREM0065-001037", kind: "releases", leadMinistryKey: "office-of-the-premier" }];

const HQ_KEYS = ["gcpe-headquarters", "gcpe-media-relations", "office-of-the-premier"] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Public API calls are answered from fixtures; calls to the target stack go to the real Core app, with the /core prefix stripped as the proxy does. */
function seedFetch(coreBase: string): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input : String(input));
    if (url.hostname === "api.news.gov.bc.ca") {
      if (url.pathname === "/api/Ministries") return json([AEST, PREMIER]);
      if (url.pathname.endsWith("/Minister")) return json(null, 404);
      if (url.pathname === "/api/Posts/Latest/ministries/office-of-the-premier") return json(PREMIER_RELEASES);
      if (url.pathname.startsWith("/api/Posts/Latest/ministries/")) return json([]);
      return json([]);
    }
    const target = new URL(url.pathname.replace(/^\/core/, "") + url.search, coreBase);
    return fetch(target, init);
  }) as typeof fetch;
}

function legacyMinistry(id: string, key: string, displayName: string, abbreviation: string) {
  return {
    Id: id, Key: key, SortOrder: 0, DisplayName: displayName, Abbreviation: abbreviation, IsActive: true,
    MinisterEmail: null, MinisterPhotoUrl: null, MinisterPageHtml: null, MinisterAddress: null, MinisterName: null, MinisterSummary: null,
    MinistryUrl: null, ParentKey: null, WeekendContactNumber: null, DisplayAdditionalName: null,
    TwitterUsername: null, FlickrUrl: null, YoutubeUrl: null, AudioUrl: null,
    ContactUserId: null, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null,
    SecondContactUserId: null, SecondContactFullName: null, SecondContactPhone: null, SecondContactMobile: null, SecondContactEmail: null,
  };
}

const legacySource = createFakeSource({
  ministries: [
    legacyMinistry("11111111-1111-1111-1111-111111111111", "gcpe-headquarters", "GCPE Headquarters", "GCPEHQ"),
    legacyMinistry("22222222-2222-2222-2222-222222222222", "gcpe-media-relations", "GCPE Media Relations", "GCPEMEDIA"),
    legacyMinistry("33333333-3333-3333-3333-333333333333", "office-of-the-premier", "Office of the Premier", "PREM"),
    legacyMinistry("44444444-4444-4444-4444-444444444444", "aest", "Ministry of Advanced Education", "AEST"),
  ],
  ministryTopics: [],
  ministryServices: [],
  ministrySectors: [],
  sectors: [],
  themes: [],
  tags: [],
  services: [],
});

async function hqFlags(tdb: TestDatabase): Promise<Record<string, boolean | undefined>> {
  const out: Record<string, boolean | undefined> = {};
  for (const key of [...HQ_KEYS, "aest"]) out[key] = (await getOrganization(tdb.db, key))?.isHq;
  return out;
}

async function publicFlags(tdb: TestDatabase): Promise<Record<string, boolean | undefined>> {
  const out: Record<string, boolean | undefined> = {};
  for (const key of [...HQ_KEYS, "aest"]) out[key] = (await getOrganization(tdb.db, key))?.isPublic;
  return out;
}

describe("HQ and public are asserted only when an organization is created", () => {
  let token: string;
  let auth: Parameters<typeof createApp>[0]["auth"];
  const open: { tdb: TestDatabase; server: Server }[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    auth = { issuer, audience, keys };
    token = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(issuer).setAudience(audience).setSubject("svc").setExpirationTime("10m").sign(pair.privateKey);
  });
  afterAll(async () => {
    for (const { tdb, server } of open) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tdb.drop();
    }
  });

  async function freshCore() {
    const tdb = await createCoreTestDb();
    const server = createApp({ db: tdb.db, subscribers: [], auth }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    open.push({ tdb, server });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seed = () => run({ targetBaseUrl: "https://boxs.ca", token, fetchImpl: seedFetch(base), delayMs: 0, log: () => {} });
    const unflag = (key: string) =>
      fetch(`${base}/api/organizations/${key}/hq`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ isHq: false }) });
    return { tdb, seed, unflag };
  }

  it("on a fresh database the seed creates GCPEHQ, GCPEMEDIA and PREM as HQ, and nothing else", async () => {
    const { tdb, seed } = await freshCore();
    expect((await seed()).ok).toBe(true);
    expect(await hqFlags(tdb)).toEqual({ "gcpe-headquarters": true, "gcpe-media-relations": true, "office-of-the-premier": true, aest: false });
  });

  it("on a fresh database the importer creates GCPEHQ, GCPEMEDIA and PREM as HQ, and nothing else", async () => {
    const { tdb } = await freshCore();
    await importLegacyReference(tdb.db, legacySource, []);
    expect(await hqFlags(tdb)).toEqual({ "gcpe-headquarters": true, "gcpe-media-relations": true, "office-of-the-premier": true, aest: false });
  });

  it("on a fresh database the importer creates GCPEHQ and GCPEMEDIA non-public, and PREM and every other ministry public", async () => {
    const { tdb } = await freshCore();
    await importLegacyReference(tdb.db, legacySource, []);
    expect(await publicFlags(tdb)).toEqual({ "gcpe-headquarters": false, "gcpe-media-relations": false, "office-of-the-premier": true, aest: true });
  });

  it("neither a re-import nor its own default changes a public flag Core.Admin set, in either direction", async () => {
    const { tdb } = await freshCore();
    await importLegacyReference(tdb.db, legacySource, []);
    // Core.Admin makes an ordinary ministry non-public and a normally-non-public HQ organization public.
    await setOrganizationPublic(tdb.db, "aest", false, []);
    await setOrganizationPublic(tdb.db, "gcpe-headquarters", true, []);
    await importLegacyReference(tdb.db, legacySource, []);
    expect((await getOrganization(tdb.db, "aest"))!.isPublic).toBe(false);
    expect((await getOrganization(tdb.db, "gcpe-headquarters"))!.isPublic).toBe(true);
  });

  it("after Core.Admin un-flags PREM, a re-seed and a re-import both leave it off", async () => {
    const { tdb, seed, unflag } = await freshCore();
    expect((await seed()).ok).toBe(true);
    expect((await unflag("office-of-the-premier")).status).toBe(200);

    expect((await seed()).ok).toBe(true);
    expect((await getOrganization(tdb.db, "office-of-the-premier"))!.isHq).toBe(false);

    await importLegacyReference(tdb.db, legacySource, []);
    expect(await hqFlags(tdb)).toEqual({ "gcpe-headquarters": true, "gcpe-media-relations": true, "office-of-the-premier": false, aest: false });
  });

  it("neither a re-seed nor a re-import turns off an HQ flag Core.Admin set on another organization", async () => {
    const { tdb, seed } = await freshCore();
    expect((await seed()).ok).toBe(true);
    await setOrganizationHq(tdb.db, "aest", true, []);
    expect((await seed()).ok).toBe(true);
    await importLegacyReference(tdb.db, legacySource, []);
    expect((await getOrganization(tdb.db, "aest"))!.isHq).toBe(true);
  });
});
