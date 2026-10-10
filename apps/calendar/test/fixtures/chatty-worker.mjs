// A stand-in for the report worker that prints the document it was given before answering.
import { parentPort } from "node:worker_threads";

parentPort.once("message", (doc) => {
  console.log(doc.title);
  console.error(doc.title);
  process.stdout.write(`${doc.title}\n`);
  setTimeout(() => parentPort.postMessage(new Uint8Array([37, 80, 68, 70])), 50);
});
