import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type express from "express";
import request from "supertest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";

export const nodMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createNodTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: nodMigrations });
}

// "core" is included only so tests can send a correctly-signed event from a source other
// than nrms and prove the receiver resolves it to "ignored" (never 401, since a wrong
// signature would mask whether the source-restriction logic itself works).
export const EVENT_SECRETS = { nrms: "nrms-secret", core: "core-secret" } as const;

let seq = 0;
export function envelope(source: string, type: string, data: unknown, aggregateId = "release"): {
  id: string;
  type: string;
  version: number;
  source: string;
  aggregateId: string;
  sequence: number;
  occurredAt: string;
  correlationId: string;
  data: unknown;
} {
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

export async function sendEvent(
  app: express.Express,
  event: ReturnType<typeof envelope>,
  secret: string | undefined = EVENT_SECRETS[event.source as keyof typeof EVENT_SECRETS],
): Promise<request.Response> {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", secret ? signPayload(secret, ts, body) : "bad-signature")
    .send(body);
}
