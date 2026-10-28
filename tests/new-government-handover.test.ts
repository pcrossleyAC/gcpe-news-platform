// End-to-end (NG-R16, final review C1/minor 5): a Core hand-over A→B goes through the real outbox,
// dispatchOnce and signed POST /events into the real NRMS, Calendar and NoD receivers, each on its
// own database, over the stack's own routes (INTERNAL_EVENT_ROUTES). Every consumer must end with A
// inactive and A's drafts, activities and subscribers on B. Before NG-R16 the hand-over's three
// events shared A's aggregate and the claim returned them in no defined order, so a consumer that
// got org.succeeded first dropped A's state events as stale and kept A active.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce, type SubscriberConfig } from "@gcpe/events";
import { succeedOrganization, upsertOrganization } from "../apps/core/src/services/organizations";
import { createCoreTestDb, healthOrg } from "../apps/core/test/helpers";
import { createApp as createNrmsApp } from "../apps/nrms/src/app";
import { organizations as nrmsOrgs } from "../apps/nrms/src/db/schema";
import { createRelease } from "../apps/nrms/src/releases/service";
import { createNrmsTestDb, editor, sampleCreate } from "../apps/nrms/test/helpers";
import { activities, orgs as calendarOrgs } from "../apps/calendar/src/db/schema";
import { createCalendarTestDb, createTestApp as createCalendarApp, EVENT_SECRETS as CALENDAR_SECRETS } from "../apps/calendar/test/helpers";
import { lists, subscribers as nodSubscribers, subscriptions } from "../apps/nod/src/db/schema";
import { createNodTestDb, createTestApp as createNodApp, EVENT_SECRETS as NOD_SECRETS } from "../apps/nod/test/helpers";
import { INTERNAL_EVENT_ROUTES } from "../apps/stack/src/env";

const NRMS_SECRET = "n".repeat(40) + "-handover-e2e";

function routeTypes(to: string): string[] {
  const route = INTERNAL_EVENT_ROUTES.find((r) => r.source === "core" && r.to === to);
  if (!route) throw new Error(`no core → ${to} route`);
  return [...route.types];
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events` };
}

describe("e2e: a hand-over reaches NRMS, the Calendar and NoD through the dispatcher", () => {
  let core: TestDatabase;
  let nrms: TestDatabase;
  let calendar: TestDatabase;
  let nod: TestDatabase;
  const servers: Server[] = [];
  let subs: SubscriberConfig[];

  beforeAll(async () => {
    [core, nrms, calendar, nod] = await Promise.all([createCoreTestDb(), createNrmsTestDb(), createCalendarTestDb(), createNodTestDb()]);
    const n = await listen(createNrmsApp({ db: nrms.db, auth: {}, eventSecrets: { core: NRMS_SECRET }, workflow: { timeZone: "America/Vancouver" } }));
    const c = await listen(createCalendarApp(calendar.db, { now: () => new Date() }));
    const d = await listen(createNodApp(nod.db));
    servers.push(n.server, c.server, d.server);
    subs = [
      { name: "nrms", url: n.url, secret: NRMS_SECRET, types: routeTypes("NRMS") },
      { name: "calendar", url: c.url, secret: CALENDAR_SECRETS.core, types: routeTypes("CALENDAR") },
      { name: "nod", url: d.url, secret: NOD_SECRETS.core, types: routeTypes("NOD") },
    ];
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await Promise.all([core?.drop(), nrms?.drop(), calendar?.drop(), nod?.drop()]);
  });

  /** Dispatches until the outbox is drained; fails on any retry, so a rejected delivery can't hide. */
  async function drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await dispatchOnce({ db: core.db, subscribers: subs, batchSize: 500 });
      expect(r).toMatchObject({ retried: 0, dead: 0 });
      if (r.delivered === 0) return total;
      total += r.delivered;
    }
  }

  it("leaves A inactive everywhere and moves drafts, activities and subscribers to B", async () => {
    await upsertOrganization(core.db, { ...healthOrg, key: "alpha", displayName: "Alpha", abbreviation: "ALPH", sortOrder: 1 }, subs);
    await upsertOrganization(core.db, { ...healthOrg, key: "beta", displayName: "Beta", abbreviation: "BETA", sortOrder: 2 }, subs);
    expect(await drain()).toBe(6);

    // Each consumer's own rows keyed to A.
    const draft = await createRelease(nrms.db, { ...sampleCreate, ministries: ["alpha"], leadMinistryKey: "alpha", sectors: [] }, editor);
    const [activity] = await calendar.db
      .insert(activities)
      .values({ title: "Upcoming", contactMinistryKey: "alpha", startAt: new Date(Date.now() + 30 * 86_400_000) })
      .returning({ id: activities.id });
    const [subscriber] = await nod.db.insert(nodSubscribers).values({ email: "reader@example.test", status: "active" }).returning({ id: nodSubscribers.id });
    await nod.db.insert(subscriptions).values({ subscriberId: subscriber!.id, listKey: "ministries:alpha" });

    // Delivered history, as a live outbox has: it steers the claim to a hash semi-join whose row
    // order is unrelated to write order (the reviewer's C1 probe).
    await core.pool.query(`
      INSERT INTO outbox_events (id, type, aggregate_id, sequence, envelope)
        SELECT gen_random_uuid(), 'org.upserted', 'org:history-' || g, 1, '{}'::jsonb FROM generate_series(1, 5000) g;
      INSERT INTO outbox_deliveries (event_id, subscriber, status)
        SELECT id, s, 'delivered' FROM outbox_events, unnest(ARRAY['nrms', 'calendar', 'nod']) s WHERE aggregate_id LIKE 'org:history-%';
      ANALYZE outbox_events; ANALYZE outbox_deliveries;`);

    await succeedOrganization(
      core.db,
      "alpha",
      { successorKeys: ["beta"], moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true },
      subs,
    );
    expect(await drain()).toBeGreaterThanOrEqual(9);

    // NRMS: A inactive, the draft now led by and listed under B.
    const nrmsA = await nrms.db.select().from(nrmsOrgs).where(eq(nrmsOrgs.key, "alpha"));
    expect(nrmsA).toMatchObject([{ isActive: false }]);
    const lead = await nrms.pool.query("SELECT lead_ministry_key AS k FROM news_releases WHERE id = $1", [draft.id]);
    expect(lead.rows).toEqual([{ k: "beta" }]);
    const cats = await nrms.pool.query("SELECT key FROM release_categories WHERE release_id = $1 AND kind = 'ministries'", [draft.id]);
    expect(cats.rows).toEqual([{ key: "beta" }]);

    // Calendar: A inactive, the upcoming activity now B's.
    expect(await calendar.db.select({ isActive: calendarOrgs.isActive }).from(calendarOrgs).where(eq(calendarOrgs.key, "alpha"))).toEqual([{ isActive: false }]);
    expect(await calendar.db.select({ k: activities.contactMinistryKey }).from(activities).where(eq(activities.id, activity!.id))).toEqual([{ k: "beta" }]);

    // NoD: A's list inactive, the subscriber now on B's list.
    expect(await nod.db.select({ active: lists.active }).from(lists).where(eq(lists.listKey, "ministries:alpha"))).toEqual([{ active: false }]);
    expect((await nod.db.select({ k: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, subscriber!.id))).map((r) => r.k)).toEqual([
      "ministries:beta",
    ]);

    // No consumer dropped any of Core's events as stale.
    for (const db of [nrms, calendar, nod]) {
      const { rows } = await db.pool.query("SELECT type, outcome FROM inbox_events WHERE source = 'core' AND outcome NOT IN ('applied', 'ignored')");
      expect(rows).toEqual([]);
    }
  });
});
