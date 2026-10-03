// Loads the recorded fixture world into a local News API database (for manual testing with gcpe-news-webapp).
import { randomUUID } from "node:crypto";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseEvent } from "@gcpe/events";
import { loadLiveFixtures } from "../src/dev/fixtures";
import { buildFixtureEvents } from "../src/dev/fixture-world";
import { createProjectionHandlers } from "../src/projections";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, pool } = createDb(url);
await runMigrations(db, new URL("../migrations", import.meta.url).pathname);
const handlers = createProjectionHandlers();
let n = 0;
for (const e of buildFixtureEvents(loadLiveFixtures())) {
  const event = parseEvent({ id: randomUUID(), type: e.type, version: 1, source: e.source, aggregateId: e.aggregateId, sequence: 1, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data: e.data });
  await db.transaction((tx) => handlers[e.type]!(tx, event));
  n++;
}
console.log(`applied ${n} fixture events`);
await pool.end();
