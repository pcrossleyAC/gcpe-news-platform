import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscribers } from "../db/schema";
import { addSubscriber } from "../subscribers";
import { claimLink, createLink, expireSessionLinks, findLink, linksSentLastHour, markLinkUsed } from "./links";
import { requestManageLink, type JourneyDeps } from "./journeys";
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

  it("claimLink marks a link used only once, reporting who won", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "verify", email: "claim@example.test", subscriberId: null, pending: null });
    expect(await claimLink(tdb.db, id)).toBe(true);
    expect(await claimLink(tdb.db, id)).toBe(false);
    expect((await findLink(tdb.db, token))?.usedAt).not.toBeNull();
  });

  // Global constraints, review focus #4: a subscriber who gets several As-It-Happens emails in
  // an hour, then clicks "Manage", must not find the request blocked by their own mail's links.
  it("send links don't count toward the cap", async () => {
    const { id: subscriberId } = await addSubscriber(tdb.db, { email: "send-cap@example.test", lists: "all" });
    for (let i = 0; i < 5; i++) {
      await createLink(tdb.db, { purpose: "manage", email: "send-cap@example.test", subscriberId, pending: null, origin: "send" });
    }
    expect(await linksSentLastHour(tdb.db, "send-cap@example.test")).toBe(0);

    const sent: { to: string; subject: string }[] = [];
    const deps: JourneyDeps = {
      db: tdb.db,
      pageUrl: "https://example.test/manage/",
      linkSecret: "k".repeat(32),
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      distribution: {
        send: async (m) => {
          sent.push({ to: m.recipients[0]!.email, subject: m.subject });
          return { batchId: "b" };
        },
      },
    };
    await requestManageLink(deps, "send-cap@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ to: "send-cap@example.test", subject: "BC Gov News On Demand Subscription Management" });
  });

  it("expireSessionLinks ends every other live link of the subscriber and keeps the one named", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "x@example.test", status: "active" }).returning();
    const keep = await createLink(tdb.db, { purpose: "change-email", email: "y@example.test", subscriberId: s!.id, pending: null });
    const other = await createLink(tdb.db, { purpose: "manage", email: "x@example.test", subscriberId: s!.id, pending: null, origin: "send" });
    expect(await expireSessionLinks(tdb.db, s!.id, keep.id)).toBe(1);
    expect((await findLink(tdb.db, other.token))!.expired).toBe(true);
    expect((await findLink(tdb.db, keep.token))!.expired).toBe(false);
  });
});
