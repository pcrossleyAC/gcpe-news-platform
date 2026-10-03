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
  // handle.closers[0] is the "updates hub" closer (the hub is enabled by default — see
  // start.ts): it must close *before* the http server (see start.ts's AppHandle doc comment
  // and updates/hub.ts), so the http server closer is spliced in right after it rather than
  // in front of the whole array, unlike every other app's main.ts.
  closers: [handle.closers[0]!, { name: "http server", close: () => closeServer(server) }, ...handle.closers.slice(1)],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
