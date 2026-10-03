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
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const closer of opts.closers) {
      await closer.close();
    }
    opts.exit(0);
  };
}

/** Resolves once `server.close()` has called back (every open connection has ended). */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
