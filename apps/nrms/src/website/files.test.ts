import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { SiteConflictError, SiteRuleError } from "./errors";
import { deleteFile, listFiles, uploadFile } from "./files";

const PDF = Buffer.from("%PDF-1.7\n% test\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);
const HTML = Buffer.from("<html><body>evil</body></html>");

describe("website/files — general file uploads", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: ObjectStore;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    root = await mkdtemp(join(tmpdir(), "nrms-site-files-"));
    store = localStore(root, "/files/");
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE site_files, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  const lastLog = async () => {
    const r = await tdb.pool.query("SELECT actor_name, area, text FROM site_log ORDER BY id DESC LIMIT 1");
    return r.rows[0] as { actor_name: string; area: string; text: string } | undefined;
  };

  it("uploads a PDF: name is slugified, url is /files/<name>, bytes are readable from the store", async () => {
    const view = await uploadFile(tdb.db, store, { name: "Budget 2026.pdf", bytes: PDF }, editor);
    expect(view.name).toBe("budget-2026.pdf");
    expect(view.url).toBe("/files/budget-2026.pdf");
    expect(view.contentType).toBe("application/pdf");
    expect(view.size).toBe(PDF.length);
    const stored = await store.get("budget-2026.pdf");
    expect(stored!.bytes.equals(PDF)).toBe(true);
    expect(await lastLog()).toMatchObject({ area: "files", text: "Uploaded budget-2026.pdf" });
  });

  it("the same name again is refused with a SiteConflictError; the original bytes survive", async () => {
    await uploadFile(tdb.db, store, { name: "budget-2026.pdf", bytes: PDF }, editor);
    await expect(uploadFile(tdb.db, store, { name: "budget-2026.pdf", bytes: PDF }, editor)).rejects.toThrow(SiteConflictError);
    const stored = await store.get("budget-2026.pdf");
    expect(stored!.bytes.equals(PDF)).toBe(true);
  });

  it("replace=true overwrites the existing file's bytes and row, and logs 'Replaced <name>'", async () => {
    const first = await uploadFile(tdb.db, store, { name: "budget-2026.pdf", bytes: PDF }, editor);
    const bigger = Buffer.concat([PDF, Buffer.from("more content")]);
    const replaced = await uploadFile(tdb.db, store, { name: "budget-2026.pdf", bytes: bigger, replace: true }, editor);
    expect(replaced.id).toBe(first.id);
    expect(replaced.size).toBe(bigger.length);
    const stored = await store.get("budget-2026.pdf");
    expect(stored!.bytes.equals(bigger)).toBe(true);
    expect(await lastLog()).toMatchObject({ area: "files", text: "Replaced budget-2026.pdf" });
  });

  it("a path-traversal name is flattened: no '/' or '..' in the stored name", async () => {
    const view = await uploadFile(tdb.db, store, { name: "../x.pdf", bytes: PDF }, editor);
    expect(view.name).toBe("x.pdf");
    expect(view.name).not.toContain("/");
    expect(view.name).not.toContain("..");
  });

  it("a very long name still uploads (the temp key used internally stays within the storage key's segment limit)", async () => {
    const longName = `${"a".repeat(95)}.pdf`;
    const view = await uploadFile(tdb.db, store, { name: longName, bytes: PDF }, editor);
    const stored = await store.get(view.name);
    expect(stored!.bytes.equals(PDF)).toBe(true);
  });

  it("a PNG uploaded as 'report.pdf' is stored and named with the correct extension", async () => {
    const view = await uploadFile(tdb.db, store, { name: "report.pdf", bytes: PNG }, editor);
    expect(view.name).toBe("report.png");
    expect(view.contentType).toBe("image/png");
  });

  it("bytes that don't match a PDF, PNG or JPEG are refused with a SiteRuleError; nothing is stored", async () => {
    await expect(uploadFile(tdb.db, store, { name: "page.pdf", bytes: HTML }, editor)).rejects.toThrow(SiteRuleError);
    expect(await listFiles(tdb.db)).toEqual({ total: 0, files: [] });
  });

  it("an empty upload is refused with a SiteRuleError", async () => {
    await expect(uploadFile(tdb.db, store, { name: "empty.pdf", bytes: Buffer.alloc(0) }, editor)).rejects.toThrow(SiteRuleError);
  });

  it("search is a case-insensitive substring of name, newest first", async () => {
    await uploadFile(tdb.db, store, { name: "Budget 2026.pdf", bytes: PDF }, editor);
    await uploadFile(tdb.db, store, { name: "Agenda.pdf", bytes: PDF }, editor);
    const found = await listFiles(tdb.db, { q: "budg" });
    expect(found.total).toBe(1);
    expect(found.files[0]!.name).toBe("budget-2026.pdf");
  });

  it("delete removes the row and the bytes", async () => {
    const view = await uploadFile(tdb.db, store, { name: "budget-2026.pdf", bytes: PDF }, editor);
    await deleteFile(tdb.db, store, view.id, editor);
    expect(await listFiles(tdb.db)).toEqual({ total: 0, files: [] });
    expect(await store.get("budget-2026.pdf")).toBeNull();
    expect(await lastLog()).toMatchObject({ area: "files", text: "Deleted budget-2026.pdf" });
  });
});
