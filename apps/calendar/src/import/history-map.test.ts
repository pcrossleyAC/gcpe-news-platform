import { describe, expect, it } from "vitest";
import { HISTORY_FIELDS, LOOK_AHEAD_HISTORY_FIELDS } from "@gcpe/calendar-contract";
import { createFakeSource } from "@gcpe/legacy-import";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { LEGACY_LOG_FIELDS, mapHistory } from "./history-map";
import { loadLegacy } from "./load";
import { selectScope } from "./scope";

const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
async function history() {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  return mapHistory(scope.logs, {
    timeZone: "America/Vancouver",
    userIdOf: (id) => (id === 11 ? "00000000-0000-4000-8000-000000000011" : null),
    actorNameOf: (id) => (id === null ? null : (s.users.find((u) => u.Id === id)?.DisplayName ?? null)),
    cityNameOf: (id) => s.lookups.cities.find((c) => c.Id === id)?.Name ?? null,
    commContactLabelOf: () => null,
    orgNameOf: (g) => (g.toLowerCase() === GUID.fin.toLowerCase() ? "Sample Finance" : g.toLowerCase() === GUID.hlth.toLowerCase() ? "Sample Health" : null),
    contactMinistryKeyOf: () => "finance",
  });
}

describe("legacy log → history (C134)", () => {
  it("never maps a legacy field onto a Look Ahead key, and every mapped key is a real history field", () => {
    for (const key of Object.values(LEGACY_LOG_FIELDS)) {
      expect(Object.keys(HISTORY_FIELDS)).toContain(key);
      expect(LOOK_AHEAD_HISTORY_FIELDS as readonly string[]).not.toContain(key);
    }
  });

  it("groups Update rows by activity, actor and second, and resolves ids to names", async () => {
    const { entries } = await history();
    const first = entries.find((e) => e.legacyKey === "log:9001")!;
    expect(first.logIds).toEqual([9001, 9002]);
    expect(first.actorId).toBe("00000000-0000-4000-8000-000000000011");
    expect(first.fields).toEqual([
      { key: "title", old: "Old sample title", new: "Sample activity 1001" },
      { key: "city", old: "Sampleton", new: "Other..." },
    ]);
  });

  it("keeps a non-imported actor's legacy name with no user, and names a missing actor", async () => {
    const { entries } = await history();
    expect(entries.find((e) => e.legacyKey === "log:9005")).toMatchObject({ actorId: null, actorName: "Finley Sample", fields: [{ key: "contact_ministry", old: "Sample Health", new: "Sample Finance" }] });
    expect(entries.find((e) => e.legacyKey === "log:9008")).toMatchObject({ actorId: null, actorName: "Unknown legacy user", fields: [{ key: "is_confirmed", old: "No", new: "Yes" }] });
  });

  it("skips Edit rows, PriorityId rows and unknown fields, each counted with its reason", async () => {
    const { skipped } = await history();
    expect(skipped).toEqual([
      { logId: 9003, reason: "Edit row (lock noise)" },
      { logId: 9004, reason: "PriorityId (dropped, R9)" },
      { logId: 9006, reason: "unknown field" },
    ]);
  });
});
