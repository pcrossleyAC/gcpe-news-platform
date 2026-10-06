import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type express from "express";
import request from "supertest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";

export const publicSiteMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createPublicSiteTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: publicSiteMigrations });
}

// "nrms" is included only so tests can send a correctly-signed event from a source other
// than news-api and prove the receiver resolves it to "ignored" (never 401, since a wrong
// signature would mask whether the source-restriction logic itself works).
export const EVENT_SECRETS = { "news-api": "news-api-secret", nrms: "nrms-secret" } as const;

let seq = 0;
export function envelope(source: string, type: string, data: unknown, aggregateId = "site") {
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
