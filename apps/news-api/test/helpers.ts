import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";

export const TZ = "America/Vancouver";
export const EVENT_SECRETS = { core: "core-secret", nrms: "nrms-secret" } as const;
export const newsMigrations = new URL("../migrations", import.meta.url).pathname;

export function createNewsTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: newsMigrations });
}

let seq = 0;
export function envelope(source: "core" | "nrms", type: string, aggregateId: string, data: unknown) {
  return {
    id: randomUUID(),
    type,
    version: 1,
    source,
    aggregateId,
    sequence: ++seq,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    data,
  };
}

export async function sendEvent(app: express.Express, event: ReturnType<typeof envelope>) {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const res = await request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(EVENT_SECRETS[event.source], ts, body))
    .send(body);
  if (res.status !== 200) throw new Error(`event ${event.type} rejected: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { outcome: string };
}
