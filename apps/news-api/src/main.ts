import { createServer } from "node:http";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startNewsApi } from "./start";

const handle = await startNewsApi(process.env);
const server = createServer(handle.app);
handle.attach?.(server);
handle.startLoops();
server.listen(handle.port, () => console.log(`[news-api] listening on ${handle.port} (${handle.tenantId}, ${handle.timeZone})`));

const shutdown = createShutdown({
  logPrefix: "[news-api]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
