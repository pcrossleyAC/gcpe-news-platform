import { rename, rm } from "node:fs/promises";

/**
 * On Windows a rename or delete fails for a moment when another process has the file open without
 * FILE_SHARE_DELETE: Defender scanning a file just written, the stack streaming the old page to a
 * client, a backup agent. Those come back as EPERM, EACCES or EBUSY and clear up within a second or
 * so. Anything else (ENOENT, EISDIR, ENOSPC...) is not waiting-related and is thrown at once.
 */
const RETRYABLE: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Waits between tries: 10 tries, about 1.1 s in all. */
export const RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 200, 200, 200, 200];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `op`, retrying it while it fails with a transient Windows sharing error. */
export async function retryWhileBusy<T>(op: () => Promise<T>, sleep: (ms: number) => Promise<void> = realSleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/** The file operations the site writer retries; swappable so tests can make them fail. */
export interface SiteFs {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts?: { force?: boolean }): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export const realSiteFs: SiteFs = { rename, rm };

/** `rename` and `rm` (force) with the retry. */
export function retryingFs(fs: SiteFs = realSiteFs) {
  return {
    rename: (from: string, to: string) => retryWhileBusy(() => fs.rename(from, to), fs.sleep),
    remove: (path: string) => retryWhileBusy(() => fs.rm(path, { force: true }), fs.sleep),
  };
}
