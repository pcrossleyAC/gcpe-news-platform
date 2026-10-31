import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { subscriberLinks, subscribers } from "./db/schema";
import { placeholderLinkLengths, recipientSubstitutions, unsubscribePageUrl, type RecipientLinkOptions } from "./recipient-links";
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
    deps = { db: tdb.db, pageUrl: opts.pageUrl, linkSecret: SECRET, render: { siteUrl: "https://news.example/site", bannerUrl: null }, distribution: { send: async () => ({ batchId: "b" }) } };
  });
  afterAll(async () => tdb.drop());

  it("gives every member a manage link, an Unsubscribe page link and a one-click unsubscribe URL, stored with origin 'send'", async () => {
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

      // N1: the body's Unsubscribe link opens the public Unsubscribe page (a sibling of the
      // manage page), never the POST-only one-click API, which answers a click (GET) with an error.
      const page = new URL(links!.unsubscribeUrl);
      expect(`${page.origin}${page.pathname}`).toBe("https://news.example/site/subscribe/unsubscribe/");
      // The List-Unsubscribe header's one-click URL stays on the API, carrying the same token.
      expect(links!.oneClickUnsubscribeUrl.startsWith(`${opts.subscribeApiUrl.replace(/\/$/, "")}/OneClickUnsubscribe/`)).toBe(true);
      const oneClickToken = decodeURIComponent(new URL(links!.oneClickUnsubscribeUrl).pathname.split("/").pop()!);
      const unsubToken = page.searchParams.get("token")!;
      expect(unsubToken).toBe(oneClickToken);
      // The page's token, passed to unsubscribe() (what the page's button calls), ends that subscriber.
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

  it("puts the Unsubscribe page next to the manage page, with or without a trailing slash", () => {
    expect(unsubscribePageUrl("https://news.example/site/subscribe/manage/")).toBe("https://news.example/site/subscribe/unsubscribe/");
    expect(unsubscribePageUrl("https://news.example/subscribe/manage")).toBe("https://news.example/subscribe/unsubscribe/");
  });

  it("placeholderLinkLengths never under-measures a real substitution, at version 1 or version 12", async () => {
    const { manageUrlLen, unsubscribeUrlLen, oneClickUnsubscribeUrlLen } = placeholderLinkLengths(opts);

    for (const unsubscribeVersion of [1, 12]) {
      const { id } = await addSubscriber(tdb.db, { email: `v${unsubscribeVersion}@example.test`, lists: "all" });
      const result = await recipientSubstitutions(tdb.db, [{ subscriberId: id, email: `v${unsubscribeVersion}@example.test`, unsubscribeVersion }], opts);
      const links = result.get(id)!;
      expect(links.manageUrl.length).toBeLessThanOrEqual(manageUrlLen);
      expect(links.unsubscribeUrl.length).toBeLessThanOrEqual(unsubscribeUrlLen);
      expect(links.oneClickUnsubscribeUrl.length).toBeLessThanOrEqual(oneClickUnsubscribeUrlLen);
    }
  });
});
