import { describe, expect, it } from "vitest";
import { eventDataSchemas } from "@gcpe/events";
import { createProjectionHandlers, SOURCE_EVENT_TYPES } from "./projections";

describe("SOURCE_EVENT_TYPES", () => {
  it("assigns every handled event type to exactly one source", () => {
    for (const type of Object.keys(createProjectionHandlers())) {
      const owners = Object.entries(SOURCE_EVENT_TYPES).filter(([, allows]) => allows(type)).map(([s]) => s);
      expect(owners, type).toHaveLength(1);
    }
  });

  it("covers every catalogued event type", () => {
    for (const type of Object.keys(eventDataSchemas)) {
      const owners = Object.entries(SOURCE_EVENT_TYPES).filter(([, allows]) => allows(type)).map(([s]) => s);
      expect(owners, type).toHaveLength(1);
    }
  });

  it("site.rebuild_requested is owned by news-api, not nrms", () => {
    expect(SOURCE_EVENT_TYPES.nrms!("site.rebuild_requested")).toBe(false);
    const newsApiChecker = SOURCE_EVENT_TYPES["news-api"] as (type: string) => boolean;
    expect(newsApiChecker("site.rebuild_requested")).toBe(true);
  });
});
