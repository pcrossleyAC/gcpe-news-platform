import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { inboxEvents, type EventHandler } from "@gcpe/events";
import { createApp } from "./app";
import { createPublicSiteTestDb, envelope, EVENT_SECRETS, sendEvent } from "../test/helpers";

describe("createApp — event receiver wiring", () => {
  let tdb: TestDatabase;
  let handler: EventHandler;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createPublicSiteTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(() => {
    handler = vi.fn(async () => {});
    app = createApp({ db: tdb.db, eventSecrets: EVENT_SECRETS, handler });
  });

  it("applies a correctly signed news-api site.rebuild_requested event and calls the handler", async () => {
    const event = envelope("news-api", "site.rebuild_requested", { pages: ["home"] });
    const res = await sendEvent(app, event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "applied" });
    expect(handler).toHaveBeenCalledTimes(1);
    const [row] = await tdb.db.select().from(inboxEvents).where(eq(inboxEvents.eventId, event.id));
    expect(row?.outcome).toBe("applied");
  });

  it("rejects a bad signature with 401 and never calls the handler", async () => {
    const event = envelope("news-api", "site.rebuild_requested", { pages: ["home"] });
    const res = await sendEvent(app, event, "wrong-secret");
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a correctly signed site.rebuild_requested event from a source other than news-api", async () => {
    const event = envelope("nrms", "site.rebuild_requested", { pages: ["home"] });
    const res = await sendEvent(app, event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "ignored" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a correctly signed news-api event of a type other than site.rebuild_requested", async () => {
    const event = envelope("news-api", "release.unpublished", { key: "K1" });
    const res = await sendEvent(app, event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "ignored" });
    expect(handler).not.toHaveBeenCalled();
  });
});
