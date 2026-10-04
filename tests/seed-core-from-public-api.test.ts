// Tests for scripts/seed-core-from-public-api.ts and its mapping library
// (scripts/lib/public-taxonomy.ts). The public API is always mocked here -- this script must
// never be run against a live server (see the task's run-time constraint).
import { describe, expect, it, vi } from "vitest";
import { orgInputSchema } from "../apps/core/src/services/organizations";
import { termInputSchema } from "../apps/core/src/services/terms";
import { extractMinisterEmail, toOrgInput, toTermInput, type PublicCategory, type PublicMinister, type PublicMinistry } from "../scripts/lib/public-taxonomy";
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
function makeFetchMock(routes: { publicMinistries?: PublicMinistry[]; publicMinister?: PublicMinister | null; publicSectors?: PublicCategory[]; publicThemes?: PublicCategory[]; publicTags?: PublicCategory[]; putStatus?: number; republishStatus?: number }) {
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
      if (url.pathname === "/api/Sectors") return jsonResponse(routes.publicSectors ?? []);
      if (url.pathname === "/api/Themes") return jsonResponse(routes.publicThemes ?? []);
      if (url.pathname === "/api/Tags") return jsonResponse(routes.publicTags ?? []);
      throw new Error(`unexpected public API path: ${url.pathname}`);
    }

    // Target deployed stack.
    if (init?.method === "PUT") return okResponse(routes.putStatus ?? 200);
    if (init?.method === "POST" && url.pathname === "/core/api/admin/republish") return okResponse(routes.republishStatus ?? 202);
    throw new Error(`unexpected target call: ${init?.method} ${url.pathname}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("run() — CLI orchestration against a mocked fetch", () => {
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

  it("PUTs organizations/:key and terms/:kind/:key with schema-valid bodies, and calls republish last", async () => {
    const { fetchImpl, calls } = makeFetchMock({
      publicMinistries: [SAMPLE_MINISTRY],
      publicMinister: SAMPLE_MINISTER,
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

    const republishIdx = calls.findIndex((c) => c.url.pathname === "/core/api/admin/republish");
    expect(republishIdx).toBeGreaterThan(-1);
    expect(republishIdx).toBe(calls.length - 1); // last call overall
    expect(calls[republishIdx]!.method).toBe("POST");
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
