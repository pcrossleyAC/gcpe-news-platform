import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startNrms } from "./start";

const handle = await startNrms(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[nrms] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[nrms]",
  exit: process.exit,
  closers: [{ name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
