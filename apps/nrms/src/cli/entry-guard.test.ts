/**
 * M1: a CLI script's "am I the process's entry point, or just imported for my exports" guard
 * used to compare `import.meta.url` against `file://${process.argv[1]}` -- a plain string
 * concatenation that never percent-encodes the path. Node's own `import.meta.url` *does*
 * percent-encode it (e.g. a space becomes `%20`), so the two never matched whenever the script
 * was invoked from a path containing a character that needs encoding -- `main()` silently never
 * ran, with no output and exit code 0, as if the file had no entry point at all. Fixed to
 * `pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url` (the same pattern
 * scripts/build-siteground.mjs already uses).
 *
 * Proven here by actually invoking each script through a symlink whose name has a space in it
 * (realistic: a path like "/Users/jane/My Documents/…"), from right next to the real file so its
 * relative imports keep resolving -- and checking `main()` actually ran (it gets as far as
 * validating env vars and exits 1 naming DATABASE_URL) rather than silently exiting 0.
 */
import { spawnSync } from "node:child_process";
import { symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsxBin = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));
const cliDir = dirname(fileURLToPath(import.meta.url));

function runViaSpacedSymlink(realFile: string): { stdout: string; stderr: string; status: number | null } {
  const linkPath = join(cliDir, `entry guard ${Date.now()}-${realFile}`);
  symlinkSync(join(cliDir, realFile), linkPath);
  try {
    const { DATABASE_URL: _unused, ...envWithoutDatabaseUrl } = process.env;
    const result = spawnSync(tsxBin, [linkPath], { encoding: "utf8", env: envWithoutDatabaseUrl });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  } finally {
    unlinkSync(linkPath);
  }
}

describe("CLI entry guards (M1)", () => {
  for (const file of ["release-holds.ts", "replay-to-news-api.ts"]) {
    it(`${file}: main() runs even when invoked through a symlink whose path has a space in it`, () => {
      const { stderr, status } = runViaSpacedSymlink(file);
      // main() ran and parseEnv's required DATABASE_URL check failed -- proof the guard matched.
      // (With the old `file://${process.argv[1]}` comparison, this exits 0 with empty stderr.)
      expect(status).toBe(1);
      expect(stderr).toMatch(/DATABASE_URL/);
    });
  }
});
