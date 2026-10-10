// A stand-in for the report worker: sends back what it was given, as the PDF bytes.
import { parentPort, workerData } from "node:worker_threads";

const messages = [];
parentPort.on("message", (m) => messages.push(m));
setTimeout(() => {
  const bytes = new TextEncoder().encode(JSON.stringify({ workerData, messages, env: { ...process.env } }));
  parentPort.postMessage(bytes, [bytes.buffer]);
}, 50);
