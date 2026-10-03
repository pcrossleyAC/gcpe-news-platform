import type { Server } from "node:http";

export interface ShutdownDeps {
  hub: { close(): void };
  server: Server;
  stopListening: () => Promise<void>;
  pool: { end(): Promise<void> };
  /** `process.exit` in production; stubbed in tests so nothing actually terminates. */
  exit: (code: number) => void;
}

/**
 * Graceful shutdown, guarded against double invocation (SIGTERM and SIGINT can both fire,
 * or a signal can repeat before the process exits).
 *
 * Order matters: `hub.close()` must run *before* `server.close()`. `hub.close()` terminates
 * every upgraded WebSocket socket; `http.Server.close()` stops accepting new connections but
 * does not resolve its callback until every connection currently open — including upgraded
 * sockets, which Node's http server keeps tracking — has ended. With a `/updates` client
 * still connected, closing the hub first is what makes `server.close()` able to resolve at
 * all; reversing the order deadlocks shutdown for as long as that client stays connected
 * (empirically confirmed: see `shutdown.test.ts`).
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.hub.close();
    await new Promise<void>((resolve) => deps.server.close(() => resolve()));
    await deps.stopListening();
    await deps.pool.end();
    deps.exit(0);
  };
}
