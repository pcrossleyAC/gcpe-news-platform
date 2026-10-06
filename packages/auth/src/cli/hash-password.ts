// Reads the password from stdin so it never lands in shell history.
//
// On a TTY, input is read a byte at a time in raw mode and never echoed -- the prompt's
// claim that input is "hidden" is only made (and only true) in that case. Piped input (no
// TTY -- e.g. `echo "$PW" | npm run auth:hash-password`) cannot be hidden by this process at
// all, since the password already exists in plain text wherever it was piped from; the
// prompt says so instead of claiming otherwise.
import { createInterface } from "node:readline/promises";
import { applyKeypress, INITIAL_KEYPRESS_STATE, type KeypressState } from "./hidden-input";
import { hashPassword } from "../password";

function readHiddenFromTTY(stdin: NodeJS.ReadStream & { fd: 0 }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let state: KeypressState = INITIAL_KEYPRESS_STATE;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk: Buffer) => {
      const result = applyKeypress(state, chunk);
      if (result.action === "submit") {
        cleanup();
        process.stderr.write("\n");
        resolve(result.value);
        return;
      }
      if (result.action === "cancel") {
        // Ctrl-C/Ctrl-D: restore the terminal before exiting, otherwise the shell is left raw.
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      state = result.state;
    };
    // Without this, an I/O error on stdin would leave the terminal stuck in raw mode with
    // the 'data' listener still attached (and this promise would hang forever).
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    // Echo off BEFORE the prompt appears, so nothing typed or pasted immediately is echoed.
    stdin.setRawMode(true);
    stdin.resume();
    process.stderr.write("Password for the local admin (input hidden): ");
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

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
  pw = process.stdin.isTTY ? await readHiddenFromTTY(process.stdin) : await readFirstLineFromPipe();
} catch (err) {
  console.error("Failed to read the password from stdin:", err instanceof Error ? err.message : err);
  process.exit(1);
}
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(await hashPassword(pw));
