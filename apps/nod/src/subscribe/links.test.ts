import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { createLink, findLink, linksSentLastHour, markLinkUsed } from "./links";
import { hashToken } from "./tokens";

describe("links", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNodTestDb(); });
  afterAll(async () => tdb.drop());

  it("stores only the hash, lowercases the email, and finds the link by its token", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "verify", email: "Pat@Example.TEST", subscriberId: null, pending: { allNews: true, listKeys: ["*"], asItHappens: true, digest: false } });
    const raw = await tdb.db.execute<{ token_hash: string; email: string }>(sql`SELECT token_hash, email FROM subscriber_links WHERE id = ${id}`);
    expect(raw.rows[0]).toEqual({ token_hash: hashToken(token), email: "pat@example.test" });
    const found = await findLink(tdb.db, token);
    expect(found?.id).toBe(id);
    expect(found?.expired).toBe(false);
    expect(await findLink(tdb.db, "not-a-token")).toBeNull();
  });

  it("reports expiry by the database clock", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "manage", email: "old@example.test", subscriberId: null, pending: null });
    await tdb.db.execute(sql`UPDATE subscriber_links SET expires_at = now() - interval '1 second' WHERE id = ${id}`);
    expect((await findLink(tdb.db, token))?.expired).toBe(true);
  });

  it("counts links created for an address in the last hour, case-insensitively", async () => {
    for (let i = 0; i < 2; i++) await createLink(tdb.db, { purpose: "manage", email: "count@example.test", subscriberId: null, pending: null });
    await tdb.db.execute(sql`UPDATE subscriber_links SET created_at = now() - interval '2 hours' WHERE email = 'count@example.test' AND id = (SELECT id FROM subscriber_links WHERE email = 'count@example.test' LIMIT 1)`);
    expect(await linksSentLastHour(tdb.db, "COUNT@example.test")).toBe(1);
  });

  it("markLinkUsed stamps used_at", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "verify", email: "u@example.test", subscriberId: null, pending: null });
    await markLinkUsed(tdb.db, id);
    expect((await findLink(tdb.db, token))?.usedAt).not.toBeNull();
  });
});
