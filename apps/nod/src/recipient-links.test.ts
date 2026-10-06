import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { subscriberLinks, subscribers } from "./db/schema";
import { recipientSubstitutions, type RecipientLinkOptions } from "./recipient-links";
import { addSubscriber } from "./subscribers";
import { confirm, unsubscribe, type JourneyDeps } from "./subscribe/journeys";

const SECRET = "k".repeat(32);

describe("recipientSubstitutions", () => {
  let tdb: TestDatabase;
  let opts: RecipientLinkOptions;
  let deps: JourneyDeps;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    opts = {
      pageUrl: "https://news.example/site/subscribe/manage/",
      subscribeApiUrl: "https://news.example/api/Subscribe/",
      linkSecret: SECRET,
    };
    // Same pageUrl/linkSecret as opts, so confirm()/unsubscribe() see the links the same way
    // the real app's JourneyDeps would.
    deps = { db: tdb.db, pageUrl: opts.pageUrl, linkSecret: SECRET, distribution: { send: async () => ({ batchId: "b" }) } };
  });
  afterAll(async () => tdb.drop());

  it("gives every member a manage link and a one-click unsubscribe URL, stored with origin 'send'", async () => {
    const seed = ["one@example.test", "two@example.test", "three@example.test"];
    const members = await Promise.all(
      seed.map(async (email) => {
        const { id } = await addSubscriber(tdb.db, { email, lists: "all" });
        return { subscriberId: id, email, unsubscribeVersion: 1 };
      }),
    );

    const result = await recipientSubstitutions(tdb.db, members, opts);
    expect(result.size).toBe(3);

    for (const m of members) {
      const links = result.get(m.subscriberId);
      expect(links).toBeDefined();

      // The manage link, run through Task 4a's confirm(), returns that subscriber's own info.
      const manageToken = new URL(links!.manageUrl).searchParams.get("token");
      expect(manageToken).toBeTruthy();
      const info = await confirm(deps, manageToken!);
      expect(info?.emailAddress).toBe(m.email);

      // The unsubscribe URL's path segment, passed to unsubscribe(), ends that subscriber.
      expect(links!.unsubscribeUrl.startsWith(`${opts.subscribeApiUrl.replace(/\/$/, "")}/OneClickUnsubscribe/`)).toBe(true);
      const unsubToken = decodeURIComponent(new URL(links!.unsubscribeUrl).pathname.split("/").pop()!);
      await unsubscribe(deps, unsubToken);
      const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, m.subscriberId));
      expect(row?.status).toBe("deleted");
    }

    const linkRows = await tdb.db
      .select()
      .from(subscriberLinks)
      .where(inArray(subscriberLinks.subscriberId, members.map((m) => m.subscriberId)));
    expect(linkRows).toHaveLength(3);
    for (const row of linkRows) {
      expect(row.purpose).toBe("manage");
      expect(row.origin).toBe("send");
    }
  });

  it("returns an empty map for no members, without querying the database", async () => {
    const result = await recipientSubstitutions(tdb.db, [], opts);
    expect(result.size).toBe(0);
  });
});
