import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startDistribution } from "./start";

const handle = await startDistribution(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[distribution] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[distribution]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
