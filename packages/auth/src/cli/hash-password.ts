// Reads the password from stdin so it never lands in shell history.
//
// On a TTY, input is read a keystroke at a time in raw mode and never echoed -- the prompt's
// claim that input is "hidden" is only made (and only true) in that case. Piped input (no
// TTY -- e.g. `echo "$PW" | npm run auth:hash-password`) cannot be hidden by this process at
// all, since the password already exists in plain text wherever it was piped from; the
// prompt says so instead of claiming otherwise.
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../password";

function readHiddenFromTTY(stdin: NodeJS.ReadStream & { fd: 0 }): Promise<string> {
  process.stderr.write("Password for the local admin (input hidden): ");
  return new Promise<string>((resolve) => {
    let pw = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        const ch = String.fromCharCode(byte);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(pw);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C: restore the terminal before exiting, otherwise the shell is left raw.
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          pw = pw.slice(0, -1);
          continue;
        }
        pw += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
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

const pw = process.stdin.isTTY ? await readHiddenFromTTY(process.stdin) : await readFirstLineFromPipe();
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(await hashPassword(pw));
