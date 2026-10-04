import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter, mintLocalToken, mintSession } from "@gcpe/auth";
import { createNrmsTestDb, createScheduledRelease, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { publishDue } from "../publisher";
import * as store from "../releases/store";

const SECRET = "z".repeat(40) + "-nrms-session-test";
const STALE = "Someone else changed this release — reload to see their changes";

describe("NRMS HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let appWithEmbeds: ReturnType<typeof createApp>;
  let editorCookie: string;
  let viewerCookie: string;
  let siteEditorCookie: string;

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000a", name: "Pat Editor", email: "pat@example.invalid", roles })).token}`;
  const post = (path: string, cookie: string, body: unknown) => request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const put = (path: string, cookie: string, body: unknown) => request(app).put(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const get = (path: string, cookie = viewerCookie) => request(app).get(path).set("cookie", cookie);
  const create = async (over: Record<string, unknown> = {}) => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" } });
    // A second app on the same db, with the Task 7 embeds dep wired — proves the wiring from
    // createApp through apiRoutes to the service (routes.ts/app.ts), not just the service itself.
    appWithEmbeds = createApp({
      db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" },
      embeds: { flickr: null, soundcloudOembed: () => Promise.reject(new Error("not used")) },
    });
    editorCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
    siteEditorCookie = await cookieFor(["NRMS.SiteEditor"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /health/live needs no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("a viewer can read categories and releases but can't create one", async () => {
    const created = await create();
    const cats = await request(app).get("/api/categories").set("cookie", viewerCookie);
    expect(cats.status).toBe(200);
    expect(cats.body.ministries.map((m: { key: string }) => m.key)).toContain("health");
    const got = await request(app).get(`/api/releases/${created.id}`).set("cookie", viewerCookie);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: created.id, status: "draft", statusText: "Draft" });
    const denied = await post("/api/releases", viewerCookie, sampleCreate);
    expect(denied.status).toBe(403);
  });

  it("an editor creates a draft: 201 with the view and its status wording", async () => {
    const res = await post("/api/releases", editorCookie, sampleCreate);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "draft", statusText: "Draft", version: 1, reference: null, key: null });
    expect(res.body.documents[0].languages[0].headline).toBe(sampleCreate.headline);
  });

  it("approve gives a reference; approving again is a 409 with the reason", async () => {
    const { id } = await create();
    const ok = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.reference).toMatch(/^NEWS-\d{5}$/);
    expect(ok.body.key).toMatch(/^\d{4}HLTH\d{4}-\d{6}$/);
    expect(ok.body.status).toBe("approved");
    const again = await post(`/api/releases/${id}/approve`, editorCookie, { version: ok.body.version });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "This has already been approved." });
  });

  it("schedule now → 200 scheduled; a stale version → 409 with the reload message", async () => {
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("scheduled");
    expect(typeof s.body.statusText).toBe("string");
    const stale = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: STALE });
  });

  it("cancel returns a scheduled release to approved", async () => {
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    const c = await post(`/api/releases/${id}/cancel`, editorCookie, { version: s.body.version });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("approved");
  });

  it("an unknown sector is a 422 with the problem list", async () => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, sectors: ["nope"] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Unknown sector: nope", problems: ["Unknown sector: nope"] });
  });

  it("a blank headline is a 400 with zod issues", async () => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, headline: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid request");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("an unknown id is a 404; deleting a scheduled release is a 409", async () => {
    const nf = await request(app).get("/api/releases/not-a-uuid").set("cookie", editorCookie);
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: "not found" });
    expect((await post("/api/releases/00000000-0000-4000-8000-000000000999/approve", editorCookie, { version: 1 })).status).toBe(404);
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    const del = await post(`/api/releases/${id}/delete`, editorCookie, { version: s.body.version });
    expect(del.status).toBe(409);
    expect(typeof del.body.error).toBe("string");
  });

  it("delete: a never-approved draft is deleted; an approved one is hidden and then reads as 404", async () => {
    const d = await create();
    expect((await post(`/api/releases/${d.id}/delete`, editorCookie, { version: 1 })).body).toEqual({ result: "deleted" });
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const hidden = await post(`/api/releases/${id}/delete`, editorCookie, { version: a.body.version });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ result: "hidden" });
    expect((await request(app).get(`/api/releases/${id}`).set("cookie", editorCookie)).status).toBe(404);
  });

  it("a cookie-authenticated POST without x-gcpe-request is refused with 403", async () => {
    const res = await request(app).post("/api/releases").set("cookie", editorCookie).send(sampleCreate);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "missing X-GCPE-Request header" });
  });

  it("hides internal error details on unexpected failures", async () => {
    const spy = vi.spyOn(store, "loadView").mockRejectedValueOnce(new Error("secret db detail at /srv/x.ts:1"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app).get("/api/releases/00000000-0000-4000-8000-000000000999").set("cookie", editorCookie);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal error" });
      expect(res.text).not.toContain("secret");
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("folder list: a viewer gets a page of list items; a bad folder is a 400", async () => {
    const { id } = await create({ headline: "Folder list release" });
    const res = await get("/api/releases?folder=drafts&type=release&pageSize=100");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body).toMatchObject({ page: 1, pageSize: 100 });
    expect(res.body.items.find((i: { id: string }) => i.id === id)).toMatchObject({ headline: "Folder list release", statusText: "Draft", leadOrganization: "Health" });
    expect((await get("/api/releases?folder=nope")).status).toBe(400);
  });

  it("search finds a release by headline and pages by 20", async () => {
    const { id } = await create({ headline: "Searchable zebra crossings" });
    const res = await get("/api/search?q=ZEBRA");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.body.items[0].id).toBe(id);
  });

  it("go-to: a known reference → 200 { id }; unknown → 404", async () => {
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const ok = await get(`/api/goto?q=${encodeURIComponent(a.body.reference)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id });
    const byPath = await get(`/api/goto?q=${encodeURIComponent(`https://news.gov.bc.ca/releases/${a.body.key}`)}`);
    expect(byPath.body).toEqual({ id });
    const nf = await get("/api/goto?q=nothing-here");
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: "not found" });
  });

  it("section PUTs: an editor saves (version increments); a viewer gets 403", async () => {
    const { id } = await create();
    const settings = await put(`/api/releases/${id}/settings`, editorCookie, {
      version: 1, activityId: 77, plannedPublishAt: null, toSubscribers: true, toMediaLists: false, mediaListKeys: ["regional"],
    });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ version: 2, activityId: 77, mediaListKeys: ["regional"], statusText: "Draft" });
    const cats = await put(`/api/releases/${id}/categories`, editorCookie, {
      version: 2, leadMinistryKey: "health", ministries: ["health", "finance"], sectors: ["health"], themes: ["families"], tags: [],
    });
    expect(cats.status).toBe(200);
    expect(cats.body).toMatchObject({ version: 3, ministries: ["finance", "health"], themes: ["families"] });
    const asset = await put(`/api/releases/${id}/asset`, editorCookie, {
      version: 3, assetUrl: "https://www.youtube.com/watch?v=abc", assetAltText: "A video", hasMediaAssets: false,
    });
    expect(asset.status).toBe(200);
    expect(asset.body).toMatchObject({ version: 4, assetUrl: "https://www.youtube.com/watch?v=abc" });
    const meta = await put(`/api/releases/${id}/meta`, editorCookie, {
      version: 4, key: null, redirectUrl: null, location: "Kelowna", summary: "A short summary.", socialMediaSummary: null, keywords: "clinics",
    });
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ version: 5, keywords: "clinics" });
    expect(meta.body.languages[0]).toMatchObject({ location: "Kelowna", summary: "A short summary.", summaryEdited: true });
    const denied = await put(`/api/releases/${id}/meta`, viewerCookie, {
      version: 5, key: null, redirectUrl: null, location: "X", summary: "", socialMediaSummary: null, keywords: null,
    });
    expect(denied.status).toBe(403);
    const stale = await put(`/api/releases/${id}/categories`, editorCookie, {
      version: 2, leadMinistryKey: "health", ministries: ["health"], sectors: [], themes: [], tags: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: STALE });
  });

  it("documents: add, edit a language, translate, reorder, remove a translation and a document", async () => {
    const { id } = await create();
    const added = await post(`/api/releases/${id}/documents`, editorCookie, { version: 1, pageTitle: "Backgrounder", layout: "formal" });
    expect(added.status).toBe(200);
    expect(added.body.version).toBe(2);
    expect(added.body.documents).toHaveLength(2);
    const [first, second] = added.body.documents as { id: string }[];

    const edited = await put(`/api/releases/${id}/documents/${second!.id}/4105`, editorCookie, {
      version: 2, pageTitle: "Backgrounder", layout: "formal", headline: "Facts", subheadline: null, organizations: "Ministry of Health",
      byline: null, bodyHtml: "<p>Fact one.</p>", pageImageId: null, contacts: [],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.documents[1].languages[0]).toMatchObject({ headline: "Facts", bodyHtml: "<p>Fact one.</p>" });

    const translated = await post(`/api/releases/${id}/documents/${second!.id}/translations`, editorCookie, { version: 3, languageId: 3084 });
    expect(translated.status).toBe(200);
    expect(translated.body.documents[1].languages.map((l: { languageId: number }) => l.languageId)).toEqual([4105, 3084]);

    const reordered = await put(`/api/releases/${id}/documents/order`, editorCookie, { version: 4, documentIds: [second!.id, first!.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.documents.map((d: { id: string }) => d.id)).toEqual([second!.id, first!.id]);

    const noFrench = await post(`/api/releases/${id}/documents/${second!.id}/translations/3084/remove`, editorCookie, { version: 5 });
    expect(noFrench.status).toBe(200);
    expect(noFrench.body.documents[0].languages).toHaveLength(1);

    const removed = await post(`/api/releases/${id}/documents/${first!.id}/remove`, editorCookie, { version: 6 });
    expect(removed.status).toBe(200);
    expect(removed.body.documents.map((d: { id: string }) => d.id)).toEqual([second!.id]);
    expect(removed.body.version).toBe(7);
  });

  it("a document language PUT normalises a body <asset> embed when the app has embeds wired (Task 7)", async () => {
    const created = await request(appWithEmbeds).post("/api/releases").set("cookie", editorCookie).set("x-gcpe-request", "1").send(sampleCreate);
    expect(created.status).toBe(201);
    const { id, documents, version } = created.body as { id: string; documents: { id: string }[]; version: number };
    const edited = await request(appWithEmbeds)
      .put(`/api/releases/${id}/documents/${documents[0]!.id}/4105`)
      .set("cookie", editorCookie)
      .set("x-gcpe-request", "1")
      .send({
        version, pageTitle: "News Release", layout: "formal", headline: "Weekend clinics open across B.C.", subheadline: null,
        organizations: "Ministry of Health", byline: null, bodyHtml: "<asset>https://youtu.be/abcdef12345</asset>", pageImageId: null, contacts: [],
      });
    expect(edited.status).toBe(200);
    expect(edited.body.documents[0].languages[0]).toMatchObject({ bodyHtml: "<asset>https://www.youtube.com/watch?v=abcdef12345</asset>" });
  });

  it("document routes: a bad language or a malformed id is a 404; a viewer can't add a document", async () => {
    const { id, version } = await create();
    const view = await get(`/api/releases/${id}`);
    const docId = view.body.documents[0].id as string;
    expect((await put(`/api/releases/${id}/documents/${docId}/9999`, editorCookie, {})).status).toBe(404);
    expect((await post(`/api/releases/${id}/documents/not-a-uuid/remove`, editorCookie, { version })).status).toBe(404);
    expect((await post(`/api/releases/not-a-uuid/documents`, editorCookie, { version, pageTitle: "X", layout: "formal" })).status).toBe(404);
    expect((await post(`/api/releases/${id}/documents`, viewerCookie, { version, pageTitle: "X", layout: "formal" })).status).toBe(403);
  });

  it("log and publications: one frozen publication after a publisher run", async () => {
    const due = await createScheduledRelease(tdb.db, { headline: "Publication history release" });
    await publishDue({ db: tdb.db, subscribers: [] });
    const log = await get(`/api/releases/${due.id}/log`);
    expect(log.status).toBe(200);
    const texts = log.body.map((e: { text: string }) => e.text);
    expect(texts[0]).toMatch(/^Published to /);
    expect(texts).toContain("Created Release");
    const all = await get(`/api/releases/${due.id}/log?all=true`);
    expect(all.body.length).toBeGreaterThanOrEqual(log.body.length);

    const pubs = await get(`/api/releases/${due.id}/publications`);
    expect(pubs.status).toBe(200);
    expect(pubs.body).toHaveLength(1);
    expect(pubs.body[0]).toMatchObject({ actorName: "System" });
    const frozen = await get(`/api/releases/${due.id}/publications/${pubs.body[0].id}`);
    expect(frozen.status).toBe(200);
    expect(frozen.body.key).toBe(due.key);
    expect((await get(`/api/releases/${due.id}/publications/999999`)).status).toBe(404);
    expect((await get(`/api/releases/${due.id}/publications/abc`)).status).toBe(404);
    expect((await get(`/api/releases/not-a-uuid/log`)).status).toBe(404);
  });

  it("lookup lists: media lists, page types and page images (no bytes)", async () => {
    await tdb.pool.query(
      "INSERT INTO page_images (name, mime_type, bytes, sort_order) VALUES ('BC Logo', 'image/png', '\\x89504e47'::bytea, 1), ('Old', 'image/png', '\\x00'::bytea, 2) ON CONFLICT DO NOTHING",
    );
    await tdb.pool.query("UPDATE page_images SET is_active = false WHERE name = 'Old'");
    await tdb.pool.query(
      "INSERT INTO page_image_languages (image_id, language_id, alt_text) SELECT id, 4105, 'BC logo' FROM page_images WHERE name = 'BC Logo' ON CONFLICT DO NOTHING",
    );
    await tdb.pool.query("INSERT INTO page_types (page_title, language_id, release_type, sort_order) VALUES ('News Release', 4105, 'release', 1) ON CONFLICT DO NOTHING");
    const lists = await get("/api/media-lists");
    expect(lists.status).toBe(200);
    expect(lists.body.map((l: { key: string }) => l.key)).toEqual(["regional", "national"]);
    const types = await get("/api/page-types");
    expect(types.status).toBe(200);
    expect(types.body).toContainEqual(expect.objectContaining({ pageTitle: "News Release", languageId: 4105, releaseType: "release" }));
    const images = await get("/api/page-images");
    expect(images.status).toBe(200);
    expect(images.body).toHaveLength(1);
    expect(images.body[0]).toMatchObject({ name: "BC Logo", altTexts: { 4105: "BC logo" } });
    expect(images.body[0]).not.toHaveProperty("bytes");
  });

  it("text and PDF versions: a viewer reads both; the PDF carries the page image; a malformed id is a 404", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const img = await tdb.pool.query<{ id: string }>(
      "INSERT INTO page_images (name, mime_type, bytes, sort_order) VALUES ('Rendition banner', 'image/png', $1, 9) RETURNING id",
      [png],
    );
    const { id } = await create({ pageImageId: img.rows[0]!.id });

    const text = await get(`/api/releases/${id}/text`);
    expect(text.status).toBe(200);
    expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(text.headers["content-disposition"]).toBe(`inline; filename="${id}.txt"`);
    expect(text.text).toContain("Weekend clinics open across B.C.");
    expect(text.text).toContain("VICTORIA - Clinics will open");

    const pdf = await get(`/api/releases/${id}/pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe(`inline; filename="${id}.pdf"`);
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.toString("latin1")).toContain("/Subtype /Image");

    expect((await get(`/api/releases/not-a-uuid/text`)).status).toBe(404);
    expect((await get(`/api/releases/not-a-uuid/pdf`)).status).toBe(404);
    expect((await get(`/api/releases/00000000-0000-4000-8000-0000000000ff/pdf`)).status).toBe(404);
    expect((await request(app).get(`/api/releases/${id}/text`)).status).toBe(401);
  });

  describe("email me a copy", () => {
    type Sent = { priority: string; subject: string; html: string; text: string; recipients: { email: string }[]; attachments: { filename: string; contentType: string; contentBase64: string }[] };
    const sent: Sent[] = [];
    let mailApp: ReturnType<typeof createApp>;
    const sessionWith = async (email: string, roles = ["NRMS.Editor"]) =>
      `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000b", name: "Eddie Editor", email, roles })).token}`;
    const emailCopy = (a: ReturnType<typeof createApp>, id: string, cookie: string) =>
      request(a).post(`/api/releases/${id}/email-copy`).set("cookie", cookie).set("x-gcpe-request", "1").send({});

    beforeAll(() => {
      mailApp = createApp({
        db: tdb.db,
        auth: { session: { secret: SECRET } },
        eventSecrets: {},
        workflow: { timeZone: "America/Vancouver" },
        distribution: {
          send: async (msg) => {
            sent.push(msg as Sent);
            return { batchId: "batch-1" };
          },
        },
      });
    });

    it("sends the caller a DRAFT copy with the PDF and text attached, and logs it", async () => {
      const { id } = await create();
      const res = await emailCopy(mailApp, id, await sessionWith("editor@example.test"));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ sentTo: "editor@example.test" });

      expect(sent).toHaveLength(1);
      const msg = sent[0]!;
      expect(msg.priority).toBe("system");
      expect(msg.recipients).toEqual([{ email: "editor@example.test" }]);
      expect(msg.subject).toBe("DRAFT - Weekend clinics open across B.C.");
      expect(msg.text).toContain("VICTORIA - Clinics will open");
      expect(msg.html).toContain("<pre>");
      expect(msg.html).toContain("Weekend clinics open across B.C.");
      expect(msg.attachments.map((a) => [a.filename, a.contentType])).toEqual([
        [`DRAFT-${id}.pdf`, "application/pdf"],
        [`DRAFT-${id}.txt`, "text/plain"],
      ]);
      expect(Buffer.from(msg.attachments[0]!.contentBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      expect(Buffer.from(msg.attachments[1]!.contentBase64, "base64").toString()).toBe(msg.text);

      const log = await get(`/api/releases/${id}/log`);
      expect(log.body.map((e: { text: string }) => e.text)).toContain("Emailed a copy to editor@example.test");
      // Read-only: no version bump.
      expect((await get(`/api/releases/${id}`)).body.version).toBe(1);
    });

    it("an approved release goes as FINAL, named by its key; the summary is HTML-escaped", async () => {
      const { id } = await create({ headline: 'Clinics <open> & "more"' });
      const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
      sent.length = 0;
      const res = await emailCopy(mailApp, id, await sessionWith("viewer@example.test", ["NRMS.Viewer"]));
      expect(res.status).toBe(202);
      const msg = sent[0]!;
      expect(msg.subject).toBe('FINAL - Clinics <open> & "more"');
      expect(msg.html).toContain("Clinics &lt;open&gt; &amp; &quot;more&quot;");
      expect(msg.html).not.toContain("<open>");
      expect(msg.html).toContain(a.body.reference);
      expect(msg.attachments.map((x) => x.filename)).toEqual([`FINAL-${a.body.key}.pdf`, `FINAL-${a.body.key}.txt`]);
    });

    it("a session without an email address is a 422", async () => {
      const { id } = await create();
      const res = await emailCopy(mailApp, id, await sessionWith(""));
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "Your account has no email address to send to." });
    });

    it("Distribution refusing the message is a 502 with a readable error, and nothing is logged", async () => {
      const failing = createApp({
        db: tdb.db,
        auth: { session: { secret: SECRET } },
        eventSecrets: {},
        workflow: { timeZone: "America/Vancouver" },
        distribution: { send: async () => Promise.reject(new Error("Distribution send failed: HTTP 400")) },
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { id } = await create();
        const res = await emailCopy(failing, id, await sessionWith("editor@example.test"));
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: "The email couldn't be sent — try again." });
        const log = await get(`/api/releases/${id}/log`);
        expect(log.body.map((e: { text: string }) => e.text)).not.toContain("Emailed a copy to editor@example.test");
      } finally {
        errors.mockRestore();
      }
    });

    it("no Distribution configured is a 503; an unknown release is a 404", async () => {
      const { id } = await create();
      const res = await emailCopy(app, id, await sessionWith("editor@example.test"));
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Email isn't configured." });
      expect((await emailCopy(mailApp, "00000000-0000-4000-8000-0000000000ff", await sessionWith("editor@example.test"))).status).toBe(404);
    });
  });

  it("local admin login: the token creates a release", async () => {
    const secret = "y".repeat(40) + "-nrms-local-test";
    const passwordHash = await hashPassword("local-test-pass");
    const localApp = createApp({
      db: tdb.db,
      auth: { local: { secret } },
      loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }),
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
    });
    const login = await request(localApp).post("/auth/local/token").send({ username: "admin", password: "local-test-pass" });
    expect(login.status).toBe(200);
    const created = await request(localApp).post("/api/releases").set("authorization", `Bearer ${login.body.access_token}`).send(sampleCreate);
    expect(created.status).toBe(201);
  });

  // Fix round 1 (review finding): NoD.SubscriberCount is a dedicated, read-only service role
  // minted for NRMS's own calls to NoD (apps/nrms/src/start.ts's nodServiceTokenOptions) — it
  // must grant nothing here. A token carrying only that role is just another unprivileged
  // bearer token against NRMS's own routes.
  it("a NoD.SubscriberCount-only token is refused by a write route", async () => {
    const secret = "w".repeat(40) + "-nod-subscriber-count-test";
    const localApp = createApp({ db: tdb.db, auth: { local: { secret } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" } });
    const token = await mintLocalToken({ secret, subject: "nrms", azp: "nrms", roles: ["NoD.SubscriberCount"] });
    const denied = await request(localApp).post("/api/releases").set("authorization", `Bearer ${token}`).send(sampleCreate);
    expect(denied.status).toBe(403);
  });

  it("POST /releases/:id/features: an NRMS.SiteEditor is refused 403; an NRMS.Editor sets Top for Home", async () => {
    const due = await createScheduledRelease(tdb.db, { headline: "Feature route release" });
    await publishDue({ db: tdb.db, subscribers: [] });

    const denied = await post(`/api/releases/${due.id}/features`, siteEditorCookie, { kind: "home", key: "default", slot: "top", on: true });
    expect(denied.status).toBe(403);

    const allowed = await post(`/api/releases/${due.id}/features`, editorCookie, { kind: "home", key: "default", slot: "top", on: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.features).toEqual([{ kind: "home", key: "default", slot: "top" }]);
  });

  it("POST /releases/:id/features: kind 'home' with a key other than 'default' is a 400", async () => {
    const due = await createScheduledRelease(tdb.db, { headline: "Feature route home-key release" });
    await publishDue({ db: tdb.db, subscribers: [] });
    const res = await post(`/api/releases/${due.id}/features`, editorCookie, { kind: "home", key: "not-default", slot: "top", on: true });
    expect(res.status).toBe(400);
  });
});
