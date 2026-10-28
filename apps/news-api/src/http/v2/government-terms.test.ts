import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTestDatabase, runMigrations, type TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope, GovernmentTermsPayload } from "@gcpe/events";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, newsMigrations } from "../../../test/helpers";
import { changes } from "../../db/schema";
import { createProjectionHandlers } from "../../projections";
import { v2Routes } from "./routes";

const payload = (publishedAt: string, label = "43rd Parliament"): GovernmentTermsPayload => ({
  publishedAt,
  currentSlug: "43rd",
  terms: [
    { slug: "43rd", label, startDate: "2024-11-18", endDate: null, legacyArchiveUrl: null },
    { slug: "42nd", label: "42nd Parliament", startDate: "2020-11-26", endDate: "2024-11-17", legacyArchiveUrl: "https://archive.example/42nd" },
  ],
});

describe("government terms snapshot", () => {
  let tdb: TestDatabase;
  let app: express.Express;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = express();
    app.use("/api/v2", v2Routes({ db: tdb.db }));
    app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE government_terms, changes CASCADE");
  });

  const apply = (data: GovernmentTermsPayload) =>
    tdb.db.transaction((tx) => createProjectionHandlers()["government_terms.published"]!(tx, { data, correlationId: "c" } as unknown as EventEnvelope));
  const termChanges = async () => (await tdb.db.select().from(changes)).filter((c) => c.kind === "government_terms");

  it("404 before any payload", async () => {
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("stores and serves a payload", async () => {
    const p = payload("2026-10-27T18:00:00.000Z");
    await apply(p);
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(p);
  });

  it("serves only the public fields, whatever else the stored document holds", async () => {
    const p = payload("2026-10-27T18:00:00.000Z");
    const extra = { ...p, internal: "x", terms: p.terms.map((t) => ({ ...t, id: "uuid", status: "current" })) };
    await tdb.pool.query("INSERT INTO government_terms (id, published_at, document) VALUES (1, $1, $2)", [p.publishedAt, JSON.stringify(extra)]);
    expect((await request(app).get("/api/v2/government-terms")).body).toEqual(p);
  });

  it("logs a warning when a snapshot is ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await apply(payload("2026-10-27T18:00:00.000Z"));
      expect(warn).not.toHaveBeenCalled();
      await apply(payload("2026-10-27T17:00:00.000Z", "older"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/ignored government terms snapshot published 2026-10-27T17:00:00.000Z: 2026-10-27T18:00:00.000Z is already stored/);
    } finally {
      warn.mockRestore();
    }
  });

  it("an older publishedAt is ignored and records no change", async () => {
    await apply(payload("2026-10-27T18:00:00.000Z"));
    await apply(payload("2026-10-27T17:00:00.000Z", "older"));
    await apply(payload("2026-10-27T18:00:00.000Z", "repeat"));
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.body.terms[0].label).toBe("43rd Parliament");
    expect(await termChanges()).toHaveLength(1);
  });

  it("a newer one replaces and records one 'government_terms' change", async () => {
    await apply(payload("2026-10-27T18:00:00.000Z"));
    await apply(payload("2026-10-28T08:00:00.000Z", "renamed"));
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.body.publishedAt).toBe("2026-10-28T08:00:00.000Z");
    expect(res.body.terms[0].label).toBe("renamed");
    const rows = await termChanges();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(expect.objectContaining({ kind: "government_terms", key: null }));
  });
});

describe("migration 0010 on a populated database", () => {
  let tdb: TestDatabase;
  let partial: string;
  beforeAll(async () => {
    partial = await mkdtemp(join(tmpdir(), "news-mig-"));
    await cp(newsMigrations, partial, { recursive: true });
    const journalPath = join(partial, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0009_site_settings") + 1);
    await writeFile(journalPath, JSON.stringify(journal));
    tdb = await createTestDatabase({ migrationsFolder: partial });
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(partial, { recursive: true, force: true });
  });

  it("keeps existing change rows and then accepts 'government_terms' changes", async () => {
    await tdb.pool.query("INSERT INTO changes (kind, key) VALUES ('post.upserted', 'a'), ('site_settings', NULL), ('ministry', 'health')");
    await expect(tdb.pool.query("INSERT INTO changes (kind, key) VALUES ('government_terms', NULL)")).rejects.toMatchObject({ code: "23514" });
    await runMigrations(tdb.db, newsMigrations);
    await tdb.pool.query("INSERT INTO changes (kind, key) VALUES ('government_terms', NULL)");
    expect((await tdb.pool.query("SELECT kind FROM changes ORDER BY id")).rows.map((r: { kind: string }) => r.kind)).toEqual(["post.upserted", "site_settings", "ministry", "government_terms"]);
    await tdb.pool.query("INSERT INTO government_terms (published_at, document) VALUES (now(), '{}')");
    await expect(tdb.pool.query("INSERT INTO government_terms (id, published_at, document) VALUES (2, now(), '{}')")).rejects.toThrow();
  });
});
