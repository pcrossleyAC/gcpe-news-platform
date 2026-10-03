import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startPublicSite } from "./start";

const handle = await startPublicSite(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[public-site] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[public-site]",
  exit: process.exit,
  closers: [{ name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
