import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startCore } from "./start";

const handle = await startCore(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[core] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[core]",
  exit: process.exit,
  closers: [{ name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
