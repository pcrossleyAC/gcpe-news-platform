import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import type { LegacySnapshot } from "./legacy-rows";
import type { ScopeOptions } from "./scope";

/**
 * A legacy read saved to a file (`npm run calendar:snapshot`), for an import that can't reach the
 * legacy SQL Server from where it runs (SiteGround, which allows no tunnels): `loadLegacy`'s whole
 * result, gzipped JSON. Dates and byte fields (an attachment's Data) are tagged so they come back as
 * the Date and Buffer the SQL Server source gives; nothing else is changed. The header holds the
 * scope it was read with, so an import with another cutoff or other awareness categories refuses it
 * rather than importing the wrong set.
 */
export const SNAPSHOT_FORMAT = "gcpe-calendar-legacy-snapshot/1";

interface SnapshotFile {
  format: typeof SNAPSHOT_FORMAT;
  scope: ScopeOptions;
  /** When it was read (ISO), for the operator's report. */
  readAt: string;
  snapshot: LegacySnapshot;
}

export class SnapshotFileError extends Error {
  override name = "SnapshotFileError";
}

const DATE = "$date";
const BYTES = "$bytes";

function tag(this: Record<string, unknown>, key: string, value: unknown): unknown {
  // JSON.stringify has already called Date.toJSON on `value`; the holder still has the Date.
  const raw = this[key];
  if (raw instanceof Date) return { [DATE]: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  if (raw instanceof Uint8Array) return { [BYTES]: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") };
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return { [BYTES]: Buffer.from((value as { data: number[] }).data).toString("base64") };
  }
  return value;
}

function untag(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === DATE) {
      const iso = (value as Record<string, unknown>)[DATE];
      return iso === null ? new Date(Number.NaN) : new Date(iso as string);
    }
    if (keys.length === 1 && keys[0] === BYTES) return Buffer.from((value as Record<string, string>)[BYTES]!, "base64");
  }
  return value;
}

export function encodeSnapshot(snapshot: LegacySnapshot, scope: ScopeOptions, readAt: Date): Buffer {
  const file: SnapshotFile = { format: SNAPSHOT_FORMAT, scope, readAt: readAt.toISOString(), snapshot };
  return gzipSync(Buffer.from(JSON.stringify(file, tag), "utf8"));
}

/** The snapshot, refused (SnapshotFileError) unless it was read with exactly `scope`. */
export function decodeSnapshot(bytes: Uint8Array, scope: ScopeOptions): { snapshot: LegacySnapshot; readAt: string } {
  let file: SnapshotFile;
  try {
    file = JSON.parse(gunzipSync(bytes).toString("utf8"), untag) as SnapshotFile;
  } catch {
    throw new SnapshotFileError("The snapshot file can't be read: it isn't a gzipped Calendar legacy snapshot.");
  }
  if (file.format !== SNAPSHOT_FORMAT) throw new SnapshotFileError(`The snapshot file's format isn't ${SNAPSHOT_FORMAT}.`);
  if (file.scope.cutoff !== scope.cutoff) {
    throw new SnapshotFileError(`The snapshot was read with cutoff ${file.scope.cutoff}, not ${scope.cutoff}. Make a new one with this cutoff.`);
  }
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  if (!same(file.scope.awarenessCategoryIds, scope.awarenessCategoryIds)) {
    throw new SnapshotFileError("The snapshot was read with other awareness-date categories than this tenant's. Make a new one.");
  }
  return { snapshot: file.snapshot, readAt: file.readAt };
}

export async function writeSnapshotFile(path: string, snapshot: LegacySnapshot, scope: ScopeOptions, readAt = new Date()): Promise<number> {
  const bytes = encodeSnapshot(snapshot, scope, readAt);
  await writeFile(path, bytes, { mode: 0o600 });
  return bytes.length;
}

export async function readSnapshotFile(path: string, scope: ScopeOptions): Promise<{ snapshot: LegacySnapshot; readAt: string }> {
  return decodeSnapshot(await readFile(path), scope);
}
