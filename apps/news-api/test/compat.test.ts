import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createApp } from "../src/app";
import { loadLiveFixtures, type LiveFixture } from "../src/dev/fixtures";
import { buildFixtureEvents } from "../src/dev/fixture-world";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "./helpers";
import { normalize } from "./normalize";

const fx = loadLiveFixtures();

// Fixtures whose full response (status + normalized body) must match exactly.
const EXACT = [
  "post-first", "post-first-lowercase", "posts-multi", "post-unknown", "featured-posts", "keys-reference", "keys-reference-unknown",
  "latest-home", "latest-ministry-health", "keys-home", "keys-home-skip", "keys-ministry-health-upper", "home", "home-no-version", "ministries", "ministry-health", "minister-health", "ministry-unknown",
  "sectors", "sector-first", "sector-unknown", "themes", "theme-first", "theme-unknown", "tags", "tag-first", "tag-unknown",
  "slides", "slide-first", "slide-unknown", "resource-links",
];

describe("News API v1 compatibility with recorded live responses", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    for (const e of buildFixtureEvents(fx)) await sendEvent(app, envelope(e.source, e.type, e.aggregateId, e.data));
  }, 120_000);
  afterAll(async () => {
    await tdb.drop();
  });

  async function replay(f: LiveFixture) {
    const res = await request(app).get(f.path);
    const body = res.text.length ? JSON.parse(res.text) : null;
    return { status: res.status, body, contentType: (res.headers["content-type"] as string | undefined) ?? null };
  }

  for (const name of EXACT) {
    it(`matches ${name}`, async () => {
      const f = fx[name]!;
      const ours = await replay(f);
      expect(ours.status).toBe(f.status);
      expect(normalize(ours.body)).toEqual(normalize(f.body));
    });
  }

  it("matches latest-home-* kinds (first post only; older posts may be absent from the fixture world)", async () => {
    for (const kind of ["factsheets", "stories", "updates"]) {
      const f = fx[`latest-home-${kind}`]!;
      const ours = await replay(f);
      expect(ours.status).toBe(f.status);
      expect((ours.body as { key: string }[])[0]?.key).toBe((f.body as { key: string }[])[0]?.key);
    }
  });

  it("matches error semantics for unsupported version, unknown theme index and media URI", async () => {
    const bad = await replay(fx["home-bad-version"]!);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe((fx["home-bad-version"]!.body as { error: { code: string } }).error.code);
    const theme = await replay(fx["keys-theme-unknown"]!);
    expect(theme.status).toBe(404);
    expect(theme.body).toMatchObject({ title: "Not Found", status: 404 });
    expect(theme.contentType).toBe(fx["keys-theme-unknown"]!.contentType);
    expect((await replay(fx["latest-media-video"]!)).status).toBe(fx["latest-media-video"]!.status);
  });

  // Ruling P1-R5: live returned bare 500s for these two; we deliberately return well-formed responses instead.
  it("returns [] for an unsupported postKind on Keys (live: bare 500, keys-home-advisories)", async () => {
    const ours = await replay(fx["keys-home-advisories"]!);
    expect(ours.status).toBe(200);
    expect(ours.body).toEqual([]);
  });

  it("returns 404 problem JSON for an unknown category kind on Keys (live: bare 500, keys-unknown-kind)", async () => {
    const ours = await replay(fx["keys-unknown-kind"]!);
    expect(ours.status).toBe(404);
    expect(ours.body).toMatchObject({ title: "Not Found", status: 404 });
    expect(ours.contentType).toBe(fx["keys-theme-unknown"]!.contentType);
  });
});
