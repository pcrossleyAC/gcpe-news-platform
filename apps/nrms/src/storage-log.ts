import type { ObjectStore } from "@gcpe/storage";

/**
 * Deletes `key` from `store`, logging (never throwing) on failure — shared by media/files.ts
 * and website/files.ts, whose uploads/deletes each need to clean up an object-store write
 * after the fact (a failed upload's staged bytes, a replaced/deleted file's old bytes) without
 * ever failing the caller's own request over a storage-layer cleanup problem. `label` names
 * what's being deleted for the log line (e.g. "stored file", "stored site file"); `why` is the
 * caller's reason, also logged. Never logs bytes.
 */
export async function deleteQuietly(store: ObjectStore, key: string, label: string, why: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    console.error(`[nrms] could not delete ${label} ${key} (${why}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
