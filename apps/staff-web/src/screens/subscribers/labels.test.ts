import { describe, expect, it } from "vitest";
// Node-environment test (ends in .ts): reads the server's own list directly, the same way
// admin/users/roles.test.ts checks STAFF_ROLES, so a new history action can't ship without a
// label.
import { HISTORY_ACTIONS } from "../../../../nod/src/subscribe/history";
import { actorLabel, HISTORY_LABELS, historyLabel } from "./labels";

describe("history labels", () => {
  it("has a label for every action the server writes, and no others", () => {
    expect(Object.keys(HISTORY_LABELS).sort()).toEqual([...HISTORY_ACTIONS].sort());
  });

  it("falls back to the raw action and names system actors", () => {
    expect(historyLabel("something-new")).toBe("something-new");
    expect(actorLabel("subscriber")).toBe("Subscriber");
    expect(actorLabel("distribution-bounce")).toBe("Bounce processing");
    expect(actorLabel("Jamie Staff")).toBe("Jamie Staff");
  });
});
