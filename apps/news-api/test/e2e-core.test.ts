// End-to-end (final review M11): Core → outbox → dispatcher → signed POST /events → News API
// projection → Postgres NOTIFY → LISTEN → SignalR broadcast, all over real HTTP/WebSocket and
// two real databases. Nothing in between is stubbed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HubConnectionBuilder, LogLevel, type HubConnection } from "@microsoft/signalr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../core/test/helpers";
import { upsertOrganization } from "../../core/src/services/organizations";
import { createApp } from "../src/app";
import { createUpdatesHub, type UpdatesHub } from "../src/updates/hub";
import { listenForUpdates, type UpdatesListener } from "../src/updates/notify";
import { createNewsTestDb, TZ } from "./helpers";

const SECRET = "e2e-core-secret";

describe("e2e: Core organization upsert reaches News API readers and SignalR clients", () => {
  let coreDb: TestDatabase;
  let newsDb: TestDatabase;
  let hub: UpdatesHub;
  let server: Server;
  let listener: UpdatesListener;
  let conn: HubConnection;
  let baseUrl: string;

  beforeAll(async () => {
    [coreDb, newsDb] = await Promise.all([createCoreTestDb(), createNewsTestDb()]);
    // Same wiring as apps/news-api/src/main.ts.
    hub = createUpdatesHub();
    const app = createApp({ db: newsDb.db, timeZone: TZ, eventSecrets: { core: SECRET }, hubRouter: hub.router });
    server = createServer(app);
    hub.attach(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    listener = await listenForUpdates(newsDb.pool, (target, keys) => hub.broadcast(target, keys), { onReconnect: () => hub.disconnectAll() });
    conn = new HubConnectionBuilder().withUrl(`${baseUrl}/updates`).configureLogging(LogLevel.None).build();
    await conn.start();
  });

  afterAll(async () => {
    await conn?.stop();
    hub?.close();
    if (server) await new Promise((r) => server.close(r));
    await listener?.stop();
    await Promise.all([coreDb?.drop(), newsDb?.drop()]);
  });

  it("serves the ministry from GET /api/Ministries and pushes MinistryUpdate over SignalR", async () => {
    const subscribers: SubscriberConfig[] = [{ name: "news-api", url: `${baseUrl}/events`, secret: SECRET, types: ["*"] }];
    const ministryUpdate = new Promise<string[]>((resolve) => conn.on("MinistryUpdate", (keys: string[]) => resolve(keys)));

    const { changed } = await upsertOrganization(coreDb.db, healthOrg, subscribers);
    expect(changed).toBe(true);
    expect(await dispatchOnce({ db: coreDb.db, subscribers })).toEqual({ delivered: 1, retried: 0, dead: 0 });

    expect(await ministryUpdate).toEqual(["health"]);

    const res = await fetch(`${baseUrl}/api/Ministries?api-version=1.0`);
    expect(res.status).toBe(200);
    const ministries = (await res.json()) as { key: string; name: string }[];
    expect(ministries).toEqual([expect.objectContaining({ key: "health", name: "Health" })]);

    // The News API recorded the delivery in its inbox as applied.
    const { rows } = await newsDb.pool.query("SELECT source, type, outcome FROM inbox_events");
    expect(rows).toEqual([{ source: "core", type: "org.upserted", outcome: "applied" }]);
  });
});
