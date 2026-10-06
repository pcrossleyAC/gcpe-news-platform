import type { Server } from "node:http";

export interface Closer {
  /** Used in the log line if this step fails. */
  name: string;
  close: () => void | Promise<void>;
}

export interface ShutdownOptions {
  /** Run strictly in order, each awaited before the next starts. */
  closers: Closer[];
  /** `process.exit` in production; stubbed in tests so nothing actually terminates. */
  exit: (code: number) => void;
  logPrefix?: string;
}

/**
 * Graceful shutdown, guarded against double invocation (SIGTERM and SIGINT can both fire,
 * or a signal can repeat before the process exits).
 *
 * A closer that throws or rejects is logged and the remaining closers still run (so e.g. the
 * DB pool is still ended after a failed server close); the process then exits 1 instead of
 * 0. The returned promise never rejects — it's fired from a signal handler, where a
 * rejection would be unhandled and leave the process half-shut-down.
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    let failed = false;
    for (const closer of opts.closers) {
      try {
        await closer.close();
      } catch (e) {
        failed = true;
        console.error(`${opts.logPrefix ?? "[shutdown]"} shutdown step failed: ${closer.name}`, e);
      }
    }
    opts.exit(failed ? 1 : 0);
  };
}

/** Resolves once `server.close()` has called back (every open connection has ended). */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
