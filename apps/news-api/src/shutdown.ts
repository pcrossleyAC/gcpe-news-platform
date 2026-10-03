import type { Server } from "node:http";
import { closeServer, createShutdown } from "@gcpe/http-kit";

export interface ShutdownDeps {
  hub: { close(): void };
  server: Server;
  stopListening: () => Promise<void>;
  stopDispatcher: () => Promise<void>;
  pool: { end(): Promise<void> };
  /** `process.exit` in production; stubbed in tests so nothing actually terminates. */
  exit: (code: number) => void;
}

/**
 * The News API's shutdown sequence, built on @gcpe/http-kit's generic `createShutdown`.
 *
 * Order matters: `hub.close()` must run *before* `server.close()`. `hub.close()` terminates
 * every upgraded WebSocket socket; `http.Server.close()` stops accepting new connections but
 * does not resolve its callback until every connection currently open — including upgraded
 * sockets, which Node's http server keeps tracking — has ended. With a `/updates` client
 * still connected, closing the hub first is what makes `server.close()` able to resolve at
 * all; reversing the order deadlocks shutdown for as long as that client stays connected
 * (empirically confirmed: see `shutdown.test.ts`).
 */
export function createNewsApiShutdown(deps: ShutdownDeps): () => Promise<void> {
  return createShutdown({
    logPrefix: "[news-api]",
    exit: deps.exit,
    closers: [
      { name: "updates hub", close: () => deps.hub.close() },
      { name: "http server", close: () => closeServer(deps.server) },
      { name: "LISTEN connection", close: deps.stopListening },
      { name: "event dispatcher", close: deps.stopDispatcher },
      { name: "db pool", close: () => deps.pool.end() },
    ],
  });
}
