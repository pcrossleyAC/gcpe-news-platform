import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Fix round 1, Important #3: a real child process with piped (non-TTY) stdin -- this is the
// only way to exercise `process.stdin.isTTY === false` for real, which is the code path the
// `npm run auth:hash-password` script hits in CI and in most operators' terminals/pipes.
const cliPath = fileURLToPath(new URL("./hash-password.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));

function runPiped(stdin: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("hash-password CLI, piped (non-TTY) stdin", () => {
  it(
    "emits exactly one scrypt$ line on stdout and never echoes the password anywhere",
    async () => {
      const password = "a-piped-test-password";
      const { stdout, stderr, code } = await runPiped(password + "\n");
      expect(code).toBe(0);
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
      expect(stdout).not.toContain(password);
      expect(stderr).not.toContain(password);
    },
    20_000,
  );

  it(
    "does not claim the input is hidden when stdin is piped",
    async () => {
      const { stderr } = await runPiped("a-piped-test-password\n");
      expect(stderr).not.toMatch(/input hidden/);
      expect(stderr).toMatch(/not hidden/);
    },
    20_000,
  );

  it(
    "rejects a too-short piped password without hashing it",
    async () => {
      const { stdout, code } = await runPiped("short\n");
      expect(code).toBe(1);
      expect(stdout.trim()).toBe("");
    },
    20_000,
  );
});
