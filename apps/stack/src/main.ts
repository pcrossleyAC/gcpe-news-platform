import { createServer } from "node:http";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startStack } from "./stack";

const handle = await startStack(process.env);
const server = createServer(handle.app);
handle.attach?.(server);
handle.startLoops();
server.listen(handle.port, () => console.log(`[stack] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[stack]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
