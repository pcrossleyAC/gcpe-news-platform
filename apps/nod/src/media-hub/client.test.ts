import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMediaHub } from "@gcpe/media-hub-fake";
import { mediaHubClient, MediaHubError } from "./client";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(app: express.Express): Promise<string> {
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("mediaHubClient", () => {
  it("round-trips search, get and changes against the fake", async () => {
    const fake = createFakeMediaHub({ seed: 11, contactCount: 15, requireServiceAuth: (req, res, next) => next() });
    const app = express();
    app.use(fake.router);
    const baseUrl = await listen(app);

    const client = mediaHubClient({ baseUrl, getToken: async () => "test-token" });

    const live = fake.controls.contacts().find((c) => !c.deletedAt)!;
    const search = await client.search(live.firstName.toLowerCase(), 1, 25);
    expect(search.contacts.some((c) => c.id === live.id)).toBe(true);
    expect(search.page).toBe(1);
    expect(search.pageSize).toBe(25);

    const got = await client.get(live.id);
    expect(got).toMatchObject({ id: live.id, firstName: live.firstName });

    const missing = await client.get(999999);
    expect(missing).toBeNull();

    const before = new Date();
    await new Promise((r) => setTimeout(r, 10));
    fake.controls.changeEmail(live.id, live.emails[0]!.ref, "changed@example.test");
    const changes = await client.changes(before.toISOString(), null);
    expect(changes.contacts.map((c) => c.id)).toContain(live.id);
    expect(changes.nextCursor).toBeNull();
  });

  it("throws MediaHubError('contract') when a response fails contract validation", async () => {
    const app = express();
    app.get("/api/service/contacts/:id", (req, res) => {
      // A contract-violating body: missing `emails` entirely.
      res.json({ id: Number(req.params.id), firstName: "Taylor", lastName: "Reed", outlet: null, deletedAt: null });
    });
    const baseUrl = await listen(app);
    const client = mediaHubClient({ baseUrl, getToken: async () => "test-token" });

    await expect(client.get(1)).rejects.toMatchObject({ name: "MediaHubError", kind: "contract" });
    try {
      await client.get(1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MediaHubError);
    }
  });

  it("throws a network-kind MediaHubError on a timeout", async () => {
    const app = express();
    app.get("/api/service/contacts/:id", () => {
      // Never responds -- the client's own AbortSignal.timeout must fire.
    });
    const baseUrl = await listen(app);
    const client = mediaHubClient({ baseUrl, getToken: async () => "test-token", timeoutMs: 50 });

    await expect(client.get(1)).rejects.toMatchObject({ name: "MediaHubError", kind: "network" });
  });

  it("never includes the response body in a thrown error (no address leakage)", async () => {
    const app = express();
    app.get("/api/service/contacts", (_req, res) => {
      res.status(500).send("secret: journalist@example.test was here");
    });
    const baseUrl = await listen(app);
    const client = mediaHubClient({ baseUrl, getToken: async () => "test-token" });

    try {
      await client.search("q", 1, 25);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MediaHubError);
      expect((e as Error).message).not.toContain("journalist@example.test");
    }
  });
});
