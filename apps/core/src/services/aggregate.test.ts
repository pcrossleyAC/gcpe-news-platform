import { describe, expect, it } from "vitest";
import { CORE_SOURCE, orgAggregateId, termAggregateId } from "./aggregate";

describe("aggregate ids", () => {
  // Consumers key their inbox positions on (source, aggregateId): these strings are a wire contract.
  it("keeps the published formats stable", () => {
    expect(CORE_SOURCE).toBe("core");
    expect(orgAggregateId("health")).toBe("org:health");
    expect(termAggregateId("tag", "covid-19")).toBe("tag:covid-19");
  });
});
