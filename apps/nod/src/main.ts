import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startNod } from "./start";

const handle = await startNod(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[nod] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[nod]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
