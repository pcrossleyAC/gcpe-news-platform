import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where everything that must survive a redeploy lives (public site output, uploaded files).
 * SiteGround unpacks each deploy into a new folder under .nodeapp/, so nothing relative to
 * the app may hold state (verified 2026-10-04: the Phase 2 /site pages vanished after a deploy).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const v = env.DATA_DIR;
  if (!v) return join(home, "gcpe-data");
  return isAbsolute(v) ? v : resolve(home, v);
}

export async function ensureWritableDir(dir: string): Promise<void> {
  const probe = join(dir, `.write-test-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await rm(probe);
  } catch (e) {
    throw new Error(`data directory ${dir} is not writable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
