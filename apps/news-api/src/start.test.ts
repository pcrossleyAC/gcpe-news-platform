import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "@gcpe/auth";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb, EVENT_SECRETS } from "../test/helpers";
import { startNewsApi } from "./start";

const RS = "\u001e";

describe("startNewsApi", () => {
  // Every DB created by testEnv() this test created, dropped in afterEach — a test
  // reassigning one `let tdb` and dropping only that one leaked every earlier DB it made
  // (P2-R29 fix round 1, item 2).
  const dbs: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.drop()));
  });

  async function testEnv(): Promise<NodeJS.ProcessEnv> {
    const tdb = await createNewsTestDb();
    dbs.push(tdb);
    return {
      DATABASE_URL: tdb.url,
      EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
    };
  }

  it("returns a handle whose app answers health checks", async () => {
    const handle = await startNewsApi(await testEnv());
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("with the hub enabled (the default), closeBeforeServer holds exactly the updates hub closer", async () => {
    const handle = await startNewsApi(await testEnv());
    expect(handle.closeBeforeServer.map((c) => c.name)).toEqual(["updates hub"]);
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("runs each worker once without throwing on an empty DB", async () => {
    const handle = await startNewsApi(await testEnv());
    for (const run of Object.values(handle.workers)) {
      await run();
    }
    await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
  });

  it("closers close cleanly, with or without startLoops() having run", async () => {
    const handle = await startNewsApi(await testEnv());
    await expect(Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()))).resolves.not.toThrow();

    const started = await startNewsApi(await testEnv());
    started.startLoops();
    await expect(Promise.all([...started.closeBeforeServer, ...started.closers].map((c) => c.close()))).resolves.not.toThrow();
  });

  it("{ hub: false }: no hub router/attach/LISTEN connection, readiness without the LISTEN check, /updates/negotiate 404s, closeBeforeServer empty", async () => {
    const handle = await startNewsApi(await testEnv(), { hub: false });
    expect(handle.attach).toBeUndefined();
    expect(handle.closeBeforeServer).toEqual([]);
    expect((await request(handle.app).get("/health/ready")).status).toBe(200);
    const negotiate = await request(handle.app).post("/updates/negotiate");
    expect(negotiate.status).toBe(404);
    await Promise.all(handle.closers.map((c) => c.close()));
  });

  // P2-R29 fix round 1, item 1: this used to be apps/news-api/src/shutdown.test.ts, driving
  // createNewsApiShutdown directly with hand-built hub/server/pool — code main.ts no longer
  // calls. Moved here to drive the real path main.ts uses: startNewsApi() → the
  // closeBeforeServer/closers seam → createShutdown, with a real server and a connected
  // /updates client. With a /updates WebSocket client still connected, http.Server.close()
  // does not call back until that connection ends — Node keeps tracking upgraded sockets as
  // open connections — so the updates-hub closer (closeBeforeServer) must run *before* the
  // http server closer, or shutdown hangs for as long as the client stays connected.
  describe("shutdown (the exact main.ts path)", () => {
    /** Negotiates and completes the SignalR JSON handshake over a raw WebSocket, leaving it
     * open and registered in the hub's connected-sockets set — the state server.close() has
     * to deal with. */
    async function connectHandshakenClient(port: number): Promise<WebSocket> {
      const res = await fetch(`http://127.0.0.1:${port}/updates/negotiate?negotiateVersion=1`, { method: "POST" });
      const { connectionToken } = (await res.json()) as { connectionToken: string };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/updates?id=${connectionToken}`);
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      const handshakeAck = new Promise<void>((resolve) => (ws.onmessage = () => resolve()));
      ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      await handshakeAck;
      return ws;
    }

    /** Races `promise` against a timeout, resolving to `"done"` or `"timed-out"` instead of
     * leaving a hung promise (and therefore a hung test runner) on failure. */
    async function withTimeout(promise: Promise<unknown>, ms: number): Promise<"done" | "timed-out"> {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), ms);
      });
      const result = await Promise.race([promise.then(() => "done" as const), timeout]);
      clearTimeout(timer!);
      return result;
    }

    it("completes within ~2s even with a connected /updates client", async () => {
      const handle = await startNewsApi(await testEnv());
      const server = createServer(handle.app);
      handle.attach?.(server);
      handle.startLoops();
      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as AddressInfo).port;

      const ws = await connectHandshakenClient(port);
      try {
        const exit = vi.fn();
        // The exact shape main.ts builds.
        const shutdown = createShutdown({
          logPrefix: "[news-api]",
          exit,
          closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
        });

        const outcome = await withTimeout(shutdown(), 2000);
        expect(outcome).toBe("done");
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        ws.close();
      }
    });

    // Revert-check (not a permanent regression on its own — the test above already is):
    // confirmed by hand that swapping the order back to "server before hub" (i.e. the old
    // closers[0]-splice bug, or simply `[...handle.closers.slice(0,1 /* listen */), {http
    // server}, {name:"updates hub", ...}]`-style misordering) makes this exact test hang
    // past the 2s timeout ("timed-out", not "done") with the client still connected — see
    // the fix-round report for the transcript.
  });

  // Phase 4a task 6: startNewsApi's NoD service-token provider (serviceTokenProvider) must
  // fail fast at startup, not on the first proxied request, when NOD_BASE_URL is set but
  // neither a full Entra client-credentials config nor local-admin is available.
  describe("NoD service token selection (Phase 4a)", () => {
    it("rejects at startup when NOD_BASE_URL is set, no NOD_* Entra vars are set, and LOCAL_ADMIN_ENABLED is unset", async () => {
      const env = { ...(await testEnv()), NOD_BASE_URL: "http://127.0.0.1:1" };
      await expect(startNewsApi(env)).rejects.toThrow(/service token/);
    });

    it("starts when NOD_BASE_URL is set and LOCAL_ADMIN_ENABLED=true (the test-site fallback)", async () => {
      const hash = await hashPassword("fixture-password-for-start-tests");
      const env = {
        ...(await testEnv()),
        NOD_BASE_URL: "http://127.0.0.1:1",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: hash,
        LOCAL_AUTH_SECRET: "x".repeat(32),
      };
      const handle = await startNewsApi(env);
      expect((await request(handle.app).get("/health/live")).status).toBe(200);
      await Promise.all([...handle.closeBeforeServer, ...handle.closers].map((c) => c.close()));
    });
  });
});
