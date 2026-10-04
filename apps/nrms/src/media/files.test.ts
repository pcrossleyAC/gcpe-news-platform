import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { publishDue } from "../publisher";
import { ReleaseRuleError, VersionConflictError } from "../releases/errors";
import { toReleaseRecord } from "../releases/record";
import { createRelease, deleteRelease } from "../releases/service";
import { loadView } from "../releases/store";
import { releaseLog } from "../db/schema";
import { eq } from "drizzle-orm";
import { addReleaseFile, removeReleaseFile } from "./files";
import { addPageImage, pageImageBytes, updatePageImage } from "./page-images";

const PDF = Buffer.from("%PDF-1.7\n% test\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");

describe("release files", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: ObjectStore;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    root = await mkdtemp(join(tmpdir(), "nrms-files-test-"));
    store = localStore(root, "/files/");
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
  });
  const db = () => tdb.db;
  const draft = (over: Partial<typeof sampleCreate> = {}) => createRelease(db(), { ...sampleCreate, ...over }, editor);
  const logOf = async (id: string) => (await db().select().from(releaseLog).where(eq(releaseLog.releaseId, id))).map((l) => l.text);
  const stored = (id: string) => store.list(`releases/${id}`);

  it("stores a PDF translation, lists it in the view with its public URL, sets has_translations, bumps the version and logs it", async () => {
    const v = await draft();
    const out = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "translation", fileName: "Budget FR.pdf", bytes: PDF }, editor);
    expect(out.version).toBe(v.version + 1);
    expect(out.hasTranslations).toBe(true);
    expect(out.hasMediaAssets).toBe(false);
    expect(out.files).toHaveLength(1);
    const f = out.files[0]!;
    expect(f).toMatchObject({ kind: "translation", label: "Budget FR.pdf", contentType: "application/pdf", size: PDF.length });
    expect(f.url).toMatch(new RegExp(`^/files/releases/${v.id}/translations/[0-9a-f]{16}-budget-fr\\.pdf$`));
    const objects = await stored(v.id);
    expect(objects.map((o) => `/files/${o.key}`)).toEqual([f.url]);
    expect((await store.get(objects[0]!.key))!.bytes.equals(PDF)).toBe(true);
    expect(await logOf(v.id)).toContain("Added translation Budget FR.pdf");
    expect((await loadView(db(), v.id))!.files).toEqual(out.files);
  });

  it("refuses a PNG passed as a translation and writes nothing to the store", async () => {
    const v = await draft();
    const err = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "translation", fileName: "fr.pdf", bytes: PNG }, editor).catch((e) => e);
    expect(err).toBeInstanceOf(ReleaseRuleError);
    expect((err as ReleaseRuleError).problems).toEqual(["This file isn't a PDF."]);
    expect(await stored(v.id)).toEqual([]);
    expect((await loadView(db(), v.id))!.version).toBe(v.version);
  });

  it("refuses an HTML file passed as an asset", async () => {
    const v = await draft();
    const err = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "asset", fileName: "photo.png", bytes: HTML }, editor).catch((e) => e);
    expect(err).toBeInstanceOf(ReleaseRuleError);
    expect((err as ReleaseRuleError).problems).toEqual(["Upload a PDF, PNG or JPEG file."]);
    expect(await stored(v.id)).toEqual([]);
  });

  it("refuses an empty body", async () => {
    const v = await draft();
    const err = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "asset", fileName: "x.pdf", bytes: Buffer.alloc(0) }, editor).catch((e) => e);
    expect(err).toBeInstanceOf(ReleaseRuleError);
    expect((err as ReleaseRuleError).problems).toEqual(["The file is empty."]);
    expect(await stored(v.id)).toEqual([]);
  });

  it("removing the only translation clears has_translations, deletes the stored file and logs it", async () => {
    const v = await draft();
    const added = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "translation", fileName: "Budget FR.pdf", bytes: PDF }, editor);
    expect(await stored(v.id)).toHaveLength(1);
    const out = await removeReleaseFile(db(), store, v.id, added.files[0]!.id, added.version, editor);
    expect(out.hasTranslations).toBe(false);
    expect(out.files).toEqual([]);
    expect(out.version).toBe(added.version + 1);
    expect(await stored(v.id)).toEqual([]);
    expect(await logOf(v.id)).toContain("Removed translation Budget FR.pdf");
  });

  it("asset files set has_media_assets and are logged as media files; an asset of the wrong extension gets the right one", async () => {
    const v = await draft();
    const a = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "asset", fileName: "evil.html", bytes: PNG }, editor);
    expect(a.hasMediaAssets).toBe(true);
    expect(a.files[0]!.url).toMatch(/\/assets\/[0-9a-f]{16}-evil\.html\.png$/);
    expect(a.files[0]!.label).toBe("evil.html");
    expect(await logOf(v.id)).toContain("Added media file evil.html");
    const r = await removeReleaseFile(db(), store, v.id, a.files[0]!.id, a.version, editor);
    expect(r.hasMediaAssets).toBe(false);
    expect(await logOf(v.id)).toContain("Removed media file evil.html");
  });

  it("an advisory refuses files of either kind", async () => {
    const v = await draft({ type: "advisory", sectors: [], mediaListKeys: ["regional"] });
    for (const kind of ["translation", "asset"] as const) {
      const err = await addReleaseFile(db(), store, v.id, { version: v.version, kind, fileName: "a.pdf", bytes: PDF }, editor).catch((e) => e);
      expect(err).toBeInstanceOf(ReleaseRuleError);
      expect((err as ReleaseRuleError).problems).toEqual(["An Advisory has no translations or media files."]);
    }
    expect(await stored(v.id)).toEqual([]);
  });

  it("adding a file to a published (live) release makes it a correction: status publishing", async () => {
    const s = await createScheduledRelease(db());
    await publishDue({ db: db(), subscribers: [] });
    const live = (await loadView(db(), s.id))!;
    expect(live.status).toBe("published");
    const out = await addReleaseFile(db(), store, s.id, { version: live.version, kind: "translation", fileName: "fr.pdf", bytes: PDF }, editor);
    expect(out.status).toBe("publishing");
  });

  it("a stale version is a VersionConflictError and the stored bytes are deleted again", async () => {
    const v = await draft();
    const err = await addReleaseFile(db(), store, v.id, { version: v.version + 5, kind: "translation", fileName: "fr.pdf", bytes: PDF }, editor).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(await stored(v.id)).toEqual([]);
  });

  it("hard-deleting a draft removes its stored files", async () => {
    const v = await draft();
    const a = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "asset", fileName: "a.pdf", bytes: PDF }, editor);
    expect(await stored(v.id)).toHaveLength(1);
    expect(await deleteRelease(db(), v.id, a.version, editor, store)).toBe("deleted");
    expect(await stored(v.id)).toEqual([]);
  });

  it("toReleaseRecord lists translations and assets with absolute URLs under PUBLIC_FILES_BASE", async () => {
    const v = await draft();
    const a = await addReleaseFile(db(), store, v.id, { version: v.version, kind: "translation", fileName: "Budget FR.pdf", bytes: PDF }, editor);
    const at = { publishDate: "2026-10-04T17:00:00.000Z", timestamp: "2026-10-04T17:00:00.000Z" };
    const rec = toReleaseRecord({ ...a, key: "2026HLTH0001-000001" }, at, { filesBase: "https://example.test" });
    expect(rec.translations).toEqual([{ key: `https://example.test${a.files[0]!.url}`, label: "Budget FR.pdf", length: PDF.length }]);
    expect(rec.translations![0]!.key).toMatch(/^https:\/\/example\.test\/files\/releases\//);
    expect(rec.assets).toBeNull();
    expect(toReleaseRecord({ ...v, key: "k" }, at).translations).toBeNull();
  });
});

describe("page images", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("adds a PNG with alt texts, serves its bytes, updates it, refuses duplicates and non-images", async () => {
    const { id, name } = await addPageImage(tdb.db, { name: "BC Logo", bytes: PNG, altEn: "B.C. logo", altFr: "Logo de la C.-B.", sortOrder: 3 });
    expect(name).toBe("BC Logo");
    expect(await pageImageBytes(tdb.db, id)).toEqual({ bytes: PNG, mimeType: "image/png" });
    expect(await pageImageBytes(tdb.db, "not-a-uuid")).toBeNull();
    const up = await updatePageImage(tdb.db, id, { altFr: "Logo", isActive: false });
    expect(up).toMatchObject({ id, altEn: "B.C. logo", altFr: "Logo", isActive: false, sortOrder: 3 });
    await expect(addPageImage(tdb.db, { name: "BC Logo", bytes: PNG, altEn: "", altFr: "", sortOrder: 0 })).rejects.toThrow("A page image with that name already exists.");
    const bad = await addPageImage(tdb.db, { name: "doc", bytes: PDF, altEn: "", altFr: "", sortOrder: 0 }).catch((e) => e);
    expect(bad).toBeInstanceOf(ReleaseRuleError);
    const big = await addPageImage(tdb.db, { name: "big", bytes: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), altEn: "", altFr: "", sortOrder: 0 }).catch((e) => e);
    expect(big).toBeInstanceOf(ReleaseRuleError);
  });
});
