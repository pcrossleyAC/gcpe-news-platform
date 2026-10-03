// Reads the password from stdin so it never lands in shell history.
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../password";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
const pw = await rl.question("Password for the local admin (input hidden if a TTY is attached): ");
rl.close();
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(await hashPassword(pw));
