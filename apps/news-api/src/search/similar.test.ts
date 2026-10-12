import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mintLocalToken, NEWS_API_CHANGES_ROLE, NEWS_API_SIMILAR_ROLE } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { v2Routes } from "../http/v2/routes";
import { applyRelease, unpublishRelease } from "../projections";
import { createSimilarService, orTerms, similarRequestSchema, SIMILAR_LIMIT, type SimilarRequest } from "./similar";

const SECRET = "s".repeat(40);
const MARKER = "quokkadraftmarker";

function release(key: string, headline: string, o: { body?: string; publishDate?: string } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: "health",
    ministryKeys: ["health"],
    sectorKeys: [],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: o.body ? `<p>${o.body}</p>` : "" }],
  };
}

describe("orTerms", () => {
  it.each([
    ["Clinics open: B.C.'s rural-health plan", "clinics or open or b or c or s or rural or health or plan"],
    ["or OR Or", ""],
    ["", ""],
    ["Salmon salmon SALMON hatchery", "salmon or hatchery"],
    ['"quoted" -minus (paren)', "quoted or minus or paren"],
  ])("%j → %j", (input, expected) => expect(orTerms(input)).toBe(expected));

  it("keeps at most 32 distinct words", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(orTerms(words).split(" or ")).toHaveLength(32);
  });
});

describe("similarRequestSchema", () => {
  const ok = { text: "a", terms: "a", mode: "text" };
  it("accepts 8,000 code points of text and 1,000 of terms", () => {
    expect(similarRequestSchema.safeParse({ ...ok, text: "é".repeat(8000), terms: "a".repeat(1000) }).success).toBe(true);
  });
  it.each([
    [{ ...ok, text: "a".repeat(8001) }, "text"],
    [{ ...ok, terms: "a".repeat(1001) }, "terms"],
    [{ ...ok, mode: "semantic" }, "mode"],
    [{ ...ok, text: "a\u0000b" }, "text"],
    [{ ...ok, excludeKey: "" }, "excludeKey"],
    [{ ...ok, extra: 1 }, undefined],
  ])("refuses %j", (body, parameter) => {
    const r = similarRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success && parameter) expect(r.error.issues[0]?.path[0]).toBe(parameter);
  });
});

describe("createSimilarService (spec §7)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts CASCADE");
  });
  afterEach(() => vi.restoreAllMocks());

  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
    const embedder = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
  };
  const service = (provider: EmbeddingProvider | null, log: (l: string) => void = () => {}) =>
    createSimilarService({
      db: tdb.db,
      timeZone: TZ,
      language: "english",
      defaultLanguageId: 4105,
      publicSiteUrl: "https://site.example.test",
      threshold: 0.5,
      embedder: provider ? createGuardedEmbedder({ provider, log }) : null,
    });
  const req = (over: Partial<SimilarRequest> = {}): SimilarRequest => ({ text: "salmon habitat restoration", terms: "salmon habitat", mode: "text", ...over });

  it("text mode: published posts sharing any headline word, ranked, labelled text", async () => {
    await seed(release("T-BOTH", "salmon habitat grants"), release("T-ONE", "habitat survey"), release("T-NONE", "ferry schedule"));
    const res = await service(standInProvider()).similar(req());
    expect(res.mode).toBe("text");
    expect(res.results.map((r) => r.key)).toEqual(["T-BOTH", "T-ONE"]);
    expect(res.results[0]).toMatchObject({ match: "text", headline: "salmon habitat grants", leadMinistryKey: "health", url: "https://site.example.test/releases/T-BOTH" });
  });

  it("ai mode with the stand-in: the nearest post first, labelled ai, then text matches", async () => {
    await seed(release("A-EXACT", "salmon habitat restoration"), release("A-NEAR", "salmon count down"), release("A-FAR", "habitat"));
    const res = await service(standInProvider()).similar(req({ mode: "ai" }));
    expect(res.mode).toBe("ai");
    expect(res.results[0]).toMatchObject({ key: "A-EXACT", match: "ai" });
    // Every AI match comes before every text match ("ai" sorts before "text"), and no post twice.
    const matches = res.results.map((r) => r.match);
    expect(matches).toEqual([...matches].sort());
    expect(new Set(res.results.map((r) => r.key)).size).toBe(res.results.length);
    expect(res.results.map((r) => r.key).sort()).toEqual(["A-EXACT", "A-FAR", "A-NEAR"]);
  });

  it("ai requested without an embedder (the flag check said no): text mode, no provider", async () => {
    await seed(release("N-1", "salmon habitat restoration"));
    const res = await service(null).similar(req({ mode: "ai" }));
    expect(res).toMatchObject({ mode: "text", results: [{ key: "N-1", match: "text" }] });
  });

  it("a failing provider gives text mode and logs no draft text", async () => {
    await seed(release("F-1", "salmon habitat restoration"));
    const failing: EmbeddingProvider = { ...standInProvider(), async embed() { throw new EmbeddingError("boom"); } };
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const res = await service(failing, (l) => lines.push(l)).similar(req({ mode: "ai", text: `${MARKER} salmon`, terms: `${MARKER} salmon` }));
    expect(res.mode).toBe("text");
    expect(res.results.map((r) => r.key)).toEqual(["F-1"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(MARKER);
  });

  it("never lists an unpublished post, in either mode", async () => {
    await seed(release("U-LIVE", "salmon habitat restoration"), release("U-GONE", "salmon habitat restoration"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "U-GONE"));
    for (const mode of ["ai", "text"] as const) {
      const keys = (await service(standInProvider()).similar(req({ mode }))).results.map((r) => r.key);
      expect(keys, mode).toContain("U-LIVE");
      expect(keys, mode).not.toContain("U-GONE");
    }
  });

  it("excludeKey leaves the release itself out, in both branches", async () => {
    await seed(release("E-SELF", "salmon habitat restoration"), release("E-OTHER", "salmon habitat restoration"));
    for (const mode of ["ai", "text"] as const) {
      const keys = (await service(standInProvider()).similar(req({ mode, excludeKey: "e-self" }))).results.map((r) => r.key);
      expect(keys, mode).toEqual(["E-OTHER"]);
    }
  });

  it(`returns at most ${SIMILAR_LIMIT}`, async () => {
    await seed(...Array.from({ length: 12 }, (_, i) => release(`L-${i}`, `salmon habitat ${i}`)));
    for (const mode of ["ai", "text"] as const) expect((await service(standInProvider()).similar(req({ mode }))).results).toHaveLength(SIMILAR_LIMIT);
  });

  it("empty terms and an unembeddable text give an empty text answer", async () => {
    await seed(release("Z-1", "salmon"));
    expect(await service(standInProvider()).similar(req({ mode: "ai", text: "   ", terms: "or the" }))).toEqual({ mode: "text", results: [] });
  });

  it("stores nothing: row counts are unchanged", async () => {
    await seed(release("S-1", "salmon habitat restoration"));
    const count = async () => (await tdb.pool.query("SELECT (SELECT count(*) FROM posts) p, (SELECT count(*) FROM post_embeddings) e, (SELECT count(*) FROM changes) c")).rows[0];
    const before = await count();
    await service(standInProvider()).similar(req({ mode: "ai" }));
    expect(await count()).toEqual(before);
  });
});

describe("POST /api/v2/internal/similar", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    await tdb.db.transaction((tx) => applyRelease(tx, release("R-1", "salmon habitat restoration"), { notify: false }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  afterEach(() => vi.restoreAllMocks());

  const app = (bearer: { local: { secret: string } } | null) => {
    const service = createSimilarService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", threshold: 0.5, embedder: null });
    const a = express();
    a.use("/api/v2", v2Routes({ similar: { service, bearer } }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  const body = { text: `${MARKER} salmon habitat`, terms: "salmon habitat", mode: "ai" };
  const token = (roles: string[]) => mintLocalToken({ secret: SECRET, subject: "nrms", roles });

  it("answers with the service's result for a NewsApi.Similar token, no-store", async () => {
    const res = await request(app({ local: { secret: SECRET } })).post("/api/v2/internal/similar").set("authorization", `Bearer ${await token([NEWS_API_SIMILAR_ROLE])}`).send(body);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ mode: "text", results: [{ key: "R-1", match: "text" }] });
  });

  it("401 without a token, 403 with another service role, 503 when no bearer can be verified", async () => {
    const a = app({ local: { secret: SECRET } });
    expect((await request(a).post("/api/v2/internal/similar").send(body)).status).toBe(401);
    expect((await request(a).post("/api/v2/internal/similar").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`).send(body)).status).toBe(403);
    expect((await request(app(null)).post("/api/v2/internal/similar").send(body)).status).toBe(503);
  });

  it("400 names the parameter and never echoes the draft; nothing logs it", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const auth = `Bearer ${await token([NEWS_API_SIMILAR_ROLE])}`;
    const a = app({ local: { secret: SECRET } });
    const long = await request(a).post("/api/v2/internal/similar").set("authorization", auth).send({ ...body, text: `${MARKER} ${"x".repeat(8001)}` });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: { code: "InvalidParameter", parameter: "text" } });
    const broken = await request(a).post("/api/v2/internal/similar").set("authorization", auth).set("content-type", "application/json").send(`{"text":"${MARKER}`);
    expect(broken.status).toBe(400);
    expect(JSON.stringify(long.body) + JSON.stringify(broken.body) + lines.join("\n")).not.toContain(MARKER);
  });
});
