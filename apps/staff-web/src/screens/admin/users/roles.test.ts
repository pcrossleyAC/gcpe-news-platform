import { describe, expect, it } from "vitest";
// Node-environment test (vitest.config.ts's "node" project matches apps/*/src/**/*.test.ts —
// this file ends in .ts, not .tsx, so it lands there rather than in the jsdom project). Imports
// packages/auth/src/roles.ts directly rather than through "@gcpe/auth" (see roles.ts's comment):
// this one file has no imports of its own, so it's just as browser-safe read this way, while
// still letting this test see the server's real, authoritative list.
import { STAFF_ROLES as SERVER_STAFF_ROLES } from "../../../../../../packages/auth/src/roles";
import { STAFF_ROLES as CLIENT_STAFF_ROLES } from "./roles";

describe("staff-web's STAFF_ROLES", () => {
  it("has exactly the same roles, in the same order, as the server's STAFF_ROLES", () => {
    expect(CLIENT_STAFF_ROLES.map((r) => r.role)).toEqual([...SERVER_STAFF_ROLES]);
  });

  it("every role has a non-empty, distinct description", () => {
    const descriptions = CLIENT_STAFF_ROLES.map((r) => r.description);
    for (const d of descriptions) expect(d.length).toBeGreaterThan(0);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
