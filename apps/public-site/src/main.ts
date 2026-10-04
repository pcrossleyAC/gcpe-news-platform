import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startPublicSite } from "./start";

const handle = await startPublicSite(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[public-site] listening on ${handle.port}`));

// Fix round 1: self-heal once the http server itself is up — standalone has no "stack app not
// ready yet" race (see AppHandle.selfHeal's doc comment in start.ts), but this still must never
// throw past here and crash startup; the News API may simply not be reachable yet.
void handle
  .selfHeal()
  .then((r) => r && console.log(`[public-site] self-heal rebuilt ${r.rebuilt} posts`))
  .catch((e) => console.error(`[public-site] self-heal failed: ${e instanceof Error ? e.message : e}`));

const shutdown = createShutdown({
  logPrefix: "[public-site]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
