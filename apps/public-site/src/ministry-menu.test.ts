import { describe, expect, it } from "vitest";
import { ministry } from "../test/fixtures";
import { ministryMenu, ministryMenuHash } from "./ministry-menu";

describe("ministryMenu", () => {
  it("keeps active top-level ministries only; Office of the Premier first, then by name", () => {
    const menu = ministryMenu([
      ministry({ key: "health", name: "Health" }),
      ministry({ key: "closed", name: "Closed Ministry", isActive: false }),
      ministry({ key: "child", name: "Child Office", parentMinistryKey: "health" }),
      ministry({ key: "nullparent", name: "Education", parentMinistryKey: null }),
      ministry({ key: "premier", name: "Office of the Premier" }),
      ministry({ key: "agri", name: "Agriculture" }),
    ]);
    expect(menu).toEqual([
      { key: "premier", name: "Office of the Premier" },
      { key: "agri", name: "Agriculture" },
      { key: "nullparent", name: "Education" },
      { key: "health", name: "Health" },
    ]);
  });

  it("drops a key that isn't a safe category key", () => {
    const menu = ministryMenu([ministry({ key: "../evil", name: "Evil" }), ministry({ key: "a b", name: "Spacey" }), ministry({ key: "Health", name: "Health" })]);
    expect(menu.map((m) => m.name)).toEqual(["Health"]);
  });

  it("hash is stable for the same menu and changes when a name or the set changes", () => {
    const a = [{ key: "health", name: "Health" }];
    expect(ministryMenuHash(a)).toBe(ministryMenuHash([{ key: "health", name: "Health" }]));
    expect(ministryMenuHash(a)).not.toBe(ministryMenuHash([{ key: "health", name: "Health and Wellness" }]));
    expect(ministryMenuHash(a)).not.toBe(ministryMenuHash([...a, { key: "finance", name: "Finance" }]));
    expect(ministryMenuHash(null)).toBe("");
  });
});
