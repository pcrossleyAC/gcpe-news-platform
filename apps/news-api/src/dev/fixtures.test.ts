import { describe, expect, it } from "vitest";
import { loadLiveFixtures } from "./fixtures";

describe("loadLiveFixtures", () => {
  it("loads every recorded fixture with the expected names", () => {
    const fx = loadLiveFixtures();
    for (const name of ["latest-home", "post-first", "ministries", "minister-health", "slides", "resource-links", "home-no-version"]) {
      expect(fx[name], name).toBeDefined();
    }
    expect(fx["home-no-version"]!.status).toBe(400);
    expect(fx["post-unknown"]!.body).toBeNull();
  });
});
