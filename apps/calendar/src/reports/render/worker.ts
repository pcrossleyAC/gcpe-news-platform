import { parentPort, workerData } from "node:worker_threads";
import type { ReportDoc } from "../model";
import { renderPdf, useBcSans } from "./pdf";

// One report per worker: the worker's own heap limit bounds it, and its memory goes when it ends.
useBcSans((workerData as { fontsDir: string }).fontsDir);
parentPort!.once("message", (doc: ReportDoc) => {
  renderPdf(doc).then(
    (bytes) => parentPort!.postMessage(bytes, [bytes.buffer]),
    // pdfmake's errors can quote the report, so none of the error leaves: the parent sees an exit.
    () => process.exit(1),
  );
});
