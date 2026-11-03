import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { createFakeSource } from "@gcpe/legacy-import";
import { legacyCalendarTables, PDF_BYTES, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { loadLegacy } from "./load";
import { decodeSnapshot, encodeSnapshot, SnapshotFileError } from "./snapshot-file";

const scope = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };

describe("calendar legacy snapshot file", () => {
  it("round-trips loadLegacy's read exactly: Dates stay Dates, attachment bytes stay Buffers", async () => {
    const read = await loadLegacy(createFakeSource(legacyCalendarTables()), scope);
    const { snapshot, readAt } = decodeSnapshot(encodeSnapshot(read, scope, new Date("2026-11-02T18:00:00Z")), scope);
    expect(snapshot).toEqual(read);
    expect(readAt).toBe("2026-11-02T18:00:00.000Z");
    const dated = snapshot.activities.find((a) => a.StartDateTime !== null)!;
    expect(dated.StartDateTime).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(snapshot.files[0]!.Data)).toBe(true);
    expect(snapshot.files.some((f) => f.Data.equals(PDF_BYTES))).toBe(true);
  });

  it("refuses a snapshot read with another cutoff, or other awareness-date categories", async () => {
    const bytes = encodeSnapshot(await loadLegacy(createFakeSource(legacyCalendarTables()), scope), scope, new Date());
    expect(() => decodeSnapshot(bytes, { ...scope, cutoff: "2024-11-18" })).toThrow(new SnapshotFileError(`The snapshot was read with cutoff ${TEST_CUTOFF}, not 2024-11-18. Make a new one with this cutoff.`));
    expect(() => decodeSnapshot(bytes, { ...scope, awarenessCategoryIds: [2, 3] })).toThrow(/other awareness-date categories/);
    expect(() => decodeSnapshot(bytes, { ...scope, awarenessCategoryIds: [2] })).not.toThrow();
  });

  it("refuses a file that isn't one, without echoing its contents", () => {
    expect(() => decodeSnapshot(Buffer.from("not gzip"), scope)).toThrow(SnapshotFileError);
    expect(() => decodeSnapshot(gzipSync(Buffer.from(JSON.stringify({ format: "other", scope }))), scope)).toThrow(/format/);
  });
});
