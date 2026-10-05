/**
 * Fix round 1 (3f Task 3), finding 3: this logic moved to `@gcpe/config` (packages/config/src/
 * timezone.ts) — the always-running server (apps/nrms/src/releases/workflow.ts) needs it too,
 * and importing this package there would have pulled the `mssql` driver (this package's own
 * dependency, needed by ./source.ts for the legacy importer) into that server's module graph
 * just for a date utility. `@gcpe/config` has no such baggage. Re-exported here so every
 * existing `@gcpe/legacy-import` caller (apps/nrms/src/import/map.ts, this package's own test)
 * keeps working unchanged, with exactly one implementation behind both import paths.
 */
export { wallClockToInstant } from "@gcpe/config";
