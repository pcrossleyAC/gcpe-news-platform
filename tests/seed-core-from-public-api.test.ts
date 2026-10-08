// Tests for scripts/seed-core-from-public-api.ts and its mapping library
// (scripts/lib/public-taxonomy.ts). The public API is always mocked here -- this script must
// never be run against a live server (see the task's run-time constraint).
import { describe, expect, it, vi } from "vitest";
import { orgInputSchema } from "../apps/core/src/services/organizations";
import { termInputSchema } from "../apps/core/src/services/terms";
import {
  deriveMinistryAbbreviation,
  extractAbbreviationFromReleaseKey,
  extractMinisterEmail,
  flagsOnlyOnCreate,
  HQ_SEED_ORGANIZATIONS,
  toOrgInput,
  toTermInput,
  type PublicCategory,
  type PublicMinister,
  type PublicMinistry,
  type PublicPost,
} from "../scripts/lib/public-taxonomy";
import { run } from "../scripts/seed-core-from-public-api";

// --- Fixture-shaped sample data (shapes mirror apps/news-api/src/dto.ts's projections) --------

const SAMPLE_MINISTRY: PublicMinistry = {
  key: "AEST",
  name: "Ministry of Advanced Education and Skills Training",
  parentMinistryKey: null,
  ministryUrl: "https://news.gov.bc.ca/ministries/AEST",
  displayAdditionalName: null,
  topicLinks: [{ uri: "https://example.invalid/topic", key: "Topic Page" }],
  serviceLinks: [{ uri: "https://example.invalid/service", key: "Service Page" }],
  contactUser: {
    fullName: "Media Relations",
    phoneNumber: "250-555-0100",
    mobileNumber: null,
    emailAddress: "media@gov.bc.ca",
  },
  secondContactUser: null,
  weekendContactNumber: "250-555-0199",
  twitterFeedUsername: "AEST_BC",
  flickrUri: null,
  youtubeUri: null,
  audioUri: null,
  isActive: true,
};

const SAMPLE_MINISTER: PublicMinister = {
  headline: "Jane Minister",
  summary: "Minister of Advanced Education and Skills Training",
  details: "<p>Details</p>",
  emailHtml: '<a href="mailto: jane.minister@gov.bc.ca">jane.minister@gov.bc.ca</a>',
  photo: "https://example.invalid/jane.jpg",
  post: "PO BOX 9999 STN PROV GOVT",
};

const SAMPLE_SECTOR: PublicCategory = {
  key: "mining",
  name: "Mining",
  isActive: true,
  twitterFeedUsername: null,
  flickrUri: null,
  youtubeUri: null,
  audioUri: null,
};

const SAMPLE_THEME: PublicCategory = {
  key: "wildfire",
  name: "Wildfire",
  isActive: true,
};

const SAMPLE_TAG: PublicCategory = {
  key: "covid-19",
  name: "COVID-19",
  isActive: false,
};

describe("extractMinisterEmail", () => {
  it("extracts the raw address from the mailto fragment dto.ts's ministerEmailHtml renders", () => {
    expect(extractMinisterEmail('<a href="mailto: jane.minister@gov.bc.ca">jane.minister@gov.bc.ca</a>')).toBe("jane.minister@gov.bc.ca");
  });
  it("round-trips null and empty string", () => {
    expect(extractMinisterEmail(null)).toBeNull();
    expect(extractMinisterEmail(undefined)).toBeNull();
    expect(extractMinisterEmail("")).toBe("");
  });
  it("falls back to null for an unrecognized shape instead of guessing", () => {
    expect(extractMinisterEmail("not html")).toBeNull();
  });
});

describe("extractAbbreviationFromReleaseKey", () => {
  it("extracts the abbreviation from a legacy release key", () => {
    expect(extractAbbreviationFromReleaseKey("2026HLTH0012-000345")).toBe("HLTH");
  });
  it("handles a multi-letter abbreviation", () => {
    expect(extractAbbreviationFromReleaseKey("2025FIN0003-000012")).toBe("FIN");
  });
  it("returns null for a key that doesn't match the legacy format, and for null/undefined", () => {
    expect(extractAbbreviationFromReleaseKey("not-a-legacy-key")).toBeNull();
    expect(extractAbbreviationFromReleaseKey("2026hlth0012-000345")).toBeNull(); // lowercase letters don't match
    expect(extractAbbreviationFromReleaseKey(null)).toBeNull();
    expect(extractAbbreviationFromReleaseKey(undefined)).toBeNull();
  });
});

describe("deriveMinistryAbbreviation", () => {
  it("picks the most common abbreviation among matching release keys (majority vote)", () => {
    const posts: PublicPost[] = [
      { key: "2026HLTH0001-000001", kind: "releases", leadMinistryKey: "HLTH" },
      { key: "2026HLTH0002-000002", kind: "releases", leadMinistryKey: "HLTH" },
      { key: "2026FIN00003-000003", kind: "releases", leadMinistryKey: "HLTH" }, // minority, still parses as FIN
    ];
    expect(deriveMinistryAbbreviation(posts, "HLTH")).toBe("HLTH");
  });

  it("only counts posts of kind \"releases\"; stories/factsheets/updates are ignored even if the key matches", () => {
    const posts: PublicPost[] = [
      { key: "2026HLTH0001-000001", kind: "stories", leadMinistryKey: "HLTH" },
      { key: "2026HLTH0002-000002", kind: "factsheets", leadMinistryKey: "HLTH" },
      { key: "2026FIN0003-000003", kind: "releases", leadMinistryKey: "HLTH" },
    ];
    expect(deriveMinistryAbbreviation(posts, "HLTH")).toBe("FIN");
  });

  it("ignores posts whose leadMinistryKey doesn't match (case-insensitively matches when it does)", () => {
    const posts: PublicPost[] = [
      { key: "2026FIN0001-000001", kind: "releases", leadMinistryKey: "FIN" }, // different ministry
      { key: "2026hlth0002-000002", kind: "releases", leadMinistryKey: "hlth" }, // matches case-insensitively, but key itself is lowercase -> no abbreviation extracted
      { key: "2026HLTH0003-000003", kind: "releases", leadMinistryKey: "HLTH" },
    ];
    expect(deriveMinistryAbbreviation(posts, "hltH")).toBe("HLTH");
  });

  it("returns null when no post matches kind + leadMinistryKey, or none has a parseable legacy key", () => {
    expect(deriveMinistryAbbreviation([], "HLTH")).toBeNull();
    expect(deriveMinistryAbbreviation([{ key: "2026HLTH0001-000001", kind: "stories", leadMinistryKey: "HLTH" }], "HLTH")).toBeNull();
    expect(deriveMinistryAbbreviation([{ key: "not-legacy-shaped", kind: "releases", leadMinistryKey: "HLTH" }], "HLTH")).toBeNull();
    expect(deriveMinistryAbbreviation([{ key: "2026HLTH0001-000001", kind: "releases", leadMinistryKey: "OTHER" }], "HLTH")).toBeNull();
  });
});

describe("toOrgInput / toTermInput mapping against Core's own schemas", () => {
  it("maps a fixture-shaped ministry (+ minister) into a body that satisfies orgInputSchema", () => {
    const input = toOrgInput(SAMPLE_MINISTRY, SAMPLE_MINISTER);
    const parsed = orgInputSchema.parse(input); // throws on any schema violation
    expect(parsed.key).toBe("aest"); // lowercased
    expect(parsed.displayName).toBe(SAMPLE_MINISTRY.name);
    expect(parsed.abbreviation).toBeNull(); // not present in the public contract
    expect(parsed.sortOrder).toBe(0); // no public equivalent -> neutral default
    expect(parsed.sectorKeys).toEqual([]); // public API exposes no ministry -> sector link
    expect(parsed.minister.email).toBe("jane.minister@gov.bc.ca");
    expect(parsed.contact).toEqual({
      fullName: "Media Relations",
      phoneNumber: "250-555-0100",
      mobileNumber: null,
      emailAddress: "media@gov.bc.ca",
    });
    expect(parsed.topicLinks).toEqual([{ text: "Topic Page", url: "https://example.invalid/topic" }]);
    expect(parsed.social.twitterUsername).toBe("AEST_BC");
  });

  it("passes a derived abbreviation through to orgInputSchema's abbreviation field", () => {
    const parsed = orgInputSchema.parse(toOrgInput(SAMPLE_MINISTRY, SAMPLE_MINISTER, "AEST"));
    expect(parsed.abbreviation).toBe("AEST");
  });

  it("defaults displayName to the key when the public ministry has no name, never an empty string (orgInputSchema requires non-empty)", () => {
    const input = toOrgInput({ ...SAMPLE_MINISTRY, name: null }, null);
    const parsed = orgInputSchema.parse(input);
    expect(parsed.displayName).toBe("aest");
    expect(parsed.minister).toEqual({ name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null });
  });

  it("maps a fixture-shaped sector into a body that satisfies termInputSchema", () => {
    const parsed = termInputSchema.parse(toTermInput("sector", SAMPLE_SECTOR));
    expect(parsed).toMatchObject({ kind: "sector", key: "mining", displayName: "Mining", sortOrder: 0, isActive: true });
  });

  it("maps a fixture-shaped theme into a body that satisfies termInputSchema", () => {
    const parsed = termInputSchema.parse(toTermInput("theme", SAMPLE_THEME));
    expect(parsed).toMatchObject({ kind: "theme", key: "wildfire", displayName: "Wildfire", sortOrder: 0, isActive: true });
  });

  it("maps a fixture-shaped tag into a body that satisfies termInputSchema, preserving isActive: false", () => {
    const parsed = termInputSchema.parse(toTermInput("tag", SAMPLE_TAG));
    expect(parsed).toMatchObject({ kind: "tag", key: "covid-19", displayName: "COVID-19", sortOrder: 0, isActive: false });
  });
});

// --- CLI: run() against a mocked fetch ---------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function okResponse(status = 200): Response {
  return new Response(null, { status });
}

/** Routes a mocked fetch by method + pathname, recording every call for assertions. */
function makeFetchMock(routes: {
  publicMinistries?: PublicMinistry[];
  publicMinister?: PublicMinister | null;
  /** Keyed by ministry key (case-insensitive) -> the posts /api/Posts/Latest/ministries/:key returns. Defaults to []. */
  publicMinistryPosts?: Record<string, PublicPost[]>;
  publicSectors?: PublicCategory[];
  publicThemes?: PublicCategory[];
  publicTags?: PublicCategory[];
  putStatus?: number;
  republishStatus?: number;
  /** Organization keys Core already holds: GET /core/api/organizations/:key answers 200 for these, 404 otherwise. */
  existingOrgKeys?: string[];
  /** Overrides the status of every organization lookup. */
  lookupStatus?: number;
}) {
  const calls: { method: string; url: URL; headers: Headers; body?: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input : String(input));
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : undefined });

    if (url.hostname === "api.news.gov.bc.ca") {
      if (url.pathname === "/api/Ministries") return jsonResponse(routes.publicMinistries ?? []);
      if (/^\/api\/Ministries\/[^/]+\/Minister$/.test(url.pathname)) {
        return routes.publicMinister === undefined ? jsonResponse(routes.publicMinister, 200) : jsonResponse(routes.publicMinister);
      }
      const postsMatch = /^\/api\/Posts\/Latest\/ministries\/([^/]+)$/.exec(url.pathname);
      if (postsMatch) {
        const ministryKey = decodeURIComponent(postsMatch[1]!).toLowerCase();
        const byKey = Object.fromEntries(Object.entries(routes.publicMinistryPosts ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        expect(url.searchParams.get("postKind")).toBe("releases"); // the script always asks the server to pre-filter too
        return jsonResponse(byKey[ministryKey] ?? []);
      }
      if (url.pathname === "/api/Sectors") return jsonResponse(routes.publicSectors ?? []);
      if (url.pathname === "/api/Themes") return jsonResponse(routes.publicThemes ?? []);
      if (url.pathname === "/api/Tags") return jsonResponse(routes.publicTags ?? []);
      throw new Error(`unexpected public API path: ${url.pathname}`);
    }

    // Target deployed stack.
    const lookup = /^\/core\/api\/organizations\/([^/]+)$/.exec(url.pathname);
    if ((init?.method ?? "GET") === "GET" && lookup) {
      return okResponse(routes.lookupStatus ?? ((routes.existingOrgKeys ?? []).includes(decodeURIComponent(lookup[1]!)) ? 200 : 404));
    }
    if (init?.method === "PUT") return okResponse(routes.putStatus ?? 200);
    if (init?.method === "POST" && url.pathname === "/core/api/admin/republish") return okResponse(routes.republishStatus ?? 202);
    throw new Error(`unexpected target call: ${init?.method} ${url.pathname}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const SAMPLE_PREMIER: PublicMinistry = { ...SAMPLE_MINISTRY, key: "office-of-the-premier", name: "Office of the Premier", ministryUrl: "https://news.gov.bc.ca/ministries/office-of-the-premier", twitterFeedUsername: null };

describe("run() — CLI orchestration against a mocked fetch", () => {
  it("adds the two GCPE HQ organizations and marks the existing Office of the Premier HQ; no other body carries isHq", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY, SAMPLE_PREMIER],
      publicMinister: SAMPLE_MINISTER,
      publicMinistryPosts: { "office-of-the-premier": [{ key: "2026PREM0065-001037", kind: "releases", leadMinistryKey: "office-of-the-premier" }] },
      publicSectors: [],
      publicThemes: [],
      publicTags: [],
    });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    expect(result.ok).toBe(true);
    const orgPuts = calls.filter((c) => c.method === "PUT" && c.url.pathname.startsWith("/core/api/organizations/"));
    const bodies = new Map(orgPuts.map((c) => [c.url.pathname, JSON.parse(c.body!) as Record<string, unknown>]));
    for (const [path, abbreviation] of [["/core/api/organizations/gcpe-headquarters", "GCPEHQ"], ["/core/api/organizations/gcpe-media-relations", "GCPEMEDIA"]] as const) {
      expect(bodies.get(path)).toMatchObject({ abbreviation, isHq: true, isActive: true });
      expect(() => orgInputSchema.parse(bodies.get(path))).not.toThrow();
    }
    // The Office of the Premier is the public ministry itself, marked HQ: one PUT, its own key, its public name.
    expect(orgPuts.filter((c) => c.url.pathname === "/core/api/organizations/office-of-the-premier")).toHaveLength(1);
    expect(bodies.get("/core/api/organizations/office-of-the-premier")).toMatchObject({ displayName: "Office of the Premier", abbreviation: "PREM", isHq: true });
    // Any other public ministry's body never carries isHq, so re-seeding never changes a flag set by hand.
    expect("isHq" in bodies.get("/core/api/organizations/aest")!).toBe(false);
    expect(result.summaries.find((s) => s.kind === "hq-organizations")).toMatchObject({ upserted: 2, failed: 0 });
  });

  it("creates the two GCPE organizations non-public, and leaves both flags alone when they already exist", () => {
    for (const o of HQ_SEED_ORGANIZATIONS) expect(o).toMatchObject({ isHq: true, isPublic: false });
    const existing = flagsOnlyOnCreate(HQ_SEED_ORGANIZATIONS[0]!, true);
    expect("isHq" in existing || "isPublic" in existing).toBe(false);
    expect(flagsOnlyOnCreate(HQ_SEED_ORGANIZATIONS[0]!, false)).toMatchObject({ isHq: true, isPublic: false });
  });

  it("marks the Office of the Premier HQ even when its releases yield no abbreviation", async () => {
    const { fetchImpl, calls } = makeFetchMock({ publicMinistries: [SAMPLE_PREMIER], publicMinister: SAMPLE_MINISTER, publicSectors: [], publicThemes: [], publicTags: [] });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    const body = JSON.parse(calls.find((c) => c.method === "PUT" && c.url.pathname === "/core/api/organizations/office-of-the-premier")!.body!);
    expect(body).toMatchObject({ abbreviation: "PREM", isHq: true });
    expect(result.summaries.find((s) => s.kind === "ministries")!.noAbbreviation).toEqual([]);
  });

  it("asserts HQ only when Core does not yet hold the organization; an existing one's body omits isHq (C124)", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      publicMinistries: [SAMPLE_PREMIER],
      publicMinister: SAMPLE_MINISTER,
      publicSectors: [],
      publicThemes: [],
      publicTags: [],
      existingOrgKeys: ["office-of-the-premier", "gcpe-headquarters"],
    });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    expect(result.ok).toBe(true);
    const body = (key: string) => JSON.parse(calls.find((c) => c.method === "PUT" && c.url.pathname === `/core/api/organizations/${key}`)!.body!) as Record<string, unknown>;
    expect("isHq" in body("office-of-the-premier")).toBe(false);
    expect(body("office-of-the-premier")).toMatchObject({ abbreviation: "PREM" });
    expect("isHq" in body("gcpe-headquarters")).toBe(false);
    expect(body("gcpe-media-relations")).toMatchObject({ isHq: true });
  });

  it("counts a failed organization lookup as a failure and writes nothing for that organization", async () => {
    const { fetchImpl, calls } = makeFetchMock({ publicMinistries: [SAMPLE_PREMIER], publicMinister: SAMPLE_MINISTER, publicSectors: [], publicThemes: [], publicTags: [], lookupStatus: 503 });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.method === "PUT" && c.url.pathname.startsWith("/core/api/organizations/"))).toEqual([]);
    expect(result.summaries.find((s) => s.kind === "ministries")!.failures).toEqual([{ key: "office-of-the-premier", status: 503 }]);
    expect(result.summaries.find((s) => s.kind === "hq-organizations")).toMatchObject({ upserted: 0, failed: 2 });
  });

  it("sends the bearer header on every write, never puts the token in a URL, and never sends the session CSRF header", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY],
      publicMinister: SAMPLE_MINISTER,
      publicSectors: [SAMPLE_SECTOR],
      publicThemes: [],
      publicTags: [],
    });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "secret-token-xyz", fetchImpl, delayMs: 0, log: () => {} });

    expect(result.ok).toBe(true);
    const targetCalls = calls.filter((c) => c.url.hostname !== "api.news.gov.bc.ca");
    expect(targetCalls.length).toBeGreaterThan(0);
    for (const call of targetCalls) {
      expect(call.headers.get("authorization")).toBe("Bearer secret-token-xyz");
      expect(call.headers.has("x-gcpe-request")).toBe(false);
      expect(call.url.toString()).not.toContain("secret-token-xyz");
      expect(call.url.search).not.toContain("secret-token-xyz");
    }
  });

  it("PUTs organizations/:key and terms/:kind/:key with schema-valid bodies (including a derived abbreviation), and calls republish last", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY],
      publicMinister: SAMPLE_MINISTER,
      publicMinistryPosts: {
        AEST: [
          { key: "2026AEST0001-000001", kind: "releases", leadMinistryKey: "AEST" },
          { key: "2026AEST0002-000002", kind: "releases", leadMinistryKey: "AEST" },
          { key: "2026AEST0003-000003", kind: "stories", leadMinistryKey: "AEST" }, // wrong kind, ignored
        ],
      },
      publicSectors: [SAMPLE_SECTOR],
      publicThemes: [SAMPLE_THEME],
      publicTags: [SAMPLE_TAG],
    });
    await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });

    const putCalls = calls.filter((c) => c.method === "PUT");
    expect(putCalls.map((c) => c.url.pathname)).toEqual(
      expect.arrayContaining(["/core/api/organizations/aest", "/core/api/terms/sector/mining", "/core/api/terms/theme/wildfire", "/core/api/terms/tag/covid-19"]),
    );
    for (const call of putCalls) {
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(() => orgInputSchema.or(termInputSchema).parse(JSON.parse(call.body!))).not.toThrow();
    }
    const orgCall = putCalls.find((c) => c.url.pathname === "/core/api/organizations/aest")!;
    expect(JSON.parse(orgCall.body!).abbreviation).toBe("AEST"); // derived from the legacy release keys

    const republishIdx = calls.findIndex((c) => c.url.pathname === "/core/api/admin/republish");
    expect(republishIdx).toBeGreaterThan(-1);
    expect(republishIdx).toBe(calls.length - 1); // last call overall
    expect(calls[republishIdx]!.method).toBe("POST");
  });

  it("leaves abbreviation null and lists the ministry under \"no abbreviation found for\" when no release yields one", async () => {
    const { fetchImpl } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY],
      publicMinister: SAMPLE_MINISTER,
      publicMinistryPosts: { AEST: [] }, // no recent releases at all
      publicSectors: [],
      publicThemes: [],
      publicTags: [],
    });
    const lines: string[] = [];
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: (l) => lines.push(l) });

    const ministries = result.summaries.find((s) => s.kind === "ministries")!;
    expect(ministries.noAbbreviation).toEqual(["aest"]);
    expect(lines.some((l) => l.includes("no abbreviation found for: aest"))).toBe(true);
  });

  it("counts a non-2xx PUT as a failure, still republishes, and reports ok: false", async () => {
    const { fetchImpl } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY],
      publicMinister: SAMPLE_MINISTER,
      publicSectors: [],
      publicThemes: [],
      publicTags: [],
      putStatus: 500,
    });
    const lines: string[] = [];
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: (l) => lines.push(l) });

    expect(result.ok).toBe(false);
    expect(result.republishOk).toBe(true);
    const ministries = result.summaries.find((s) => s.kind === "ministries")!;
    expect(ministries.failed).toBe(1);
    expect(ministries.upserted).toBe(0);
    expect(ministries.failures).toEqual([{ key: "aest", status: 500 }]);
    expect(lines.some((l) => l.includes("FAILED ministries key=aest status=500"))).toBe(true);
  });

  it("reports ok: false when republish itself fails, even if every upsert succeeded", async () => {
    const { fetchImpl } = makeFetchMock({
      publicMinistries: [],
      publicSectors: [SAMPLE_SECTOR],
      publicThemes: [],
      publicTags: [],
      republishStatus: 500,
    });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    expect(result.republishOk).toBe(false);
    expect(result.ok).toBe(false);
  });
});
