// Reads the password from stdin so it never lands in shell history.
//
// On a TTY, input is read a byte at a time in raw mode and never echoed -- the prompt's
// claim that input is "hidden" is only made (and only true) in that case. Piped input (no
// TTY -- e.g. `echo "$PW" | npm run auth:hash-password`) cannot be hidden by this process at
// all, since the password already exists in plain text wherever it was piped from; the
// prompt says so instead of claiming otherwise.
import { createInterface } from "node:readline/promises";
import { readHidden } from "./read-hidden";
import { hashPassword } from "../password";

async function readFirstLineFromPipe(): Promise<string> {
  process.stderr.write("Reading password from stdin (not a TTY -- input is not hidden): ");
  const rl = createInterface({ input: process.stdin });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
  }
}

let pw: string;
try {
  pw = process.stdin.isTTY ? await readHidden("Password for the local admin (input hidden): ") : await readFirstLineFromPipe();
} catch (err) {
  console.error("Failed to read the password from stdin:", err instanceof Error ? err.message : err);
  process.exit(1);
}
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(await hashPassword(pw));
