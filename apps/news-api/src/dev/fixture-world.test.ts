import { describe, expect, it } from "vitest";
import { buildFixtureEvents, emailFromHtml } from "./fixture-world";
import { loadLiveFixtures } from "./fixtures";

describe("emailFromHtml", () => {
  it.each([
    ['<a href="mailto: HLTH.Minister@gov.bc.ca">HLTH.Minister@gov.bc.ca</a>', "HLTH.Minister@gov.bc.ca"],
    ['<a href="mailto:a.b@gov.bc.ca">x</a>', "a.b@gov.bc.ca"],
    ["<a href='mailto:a.b@gov.bc.ca'>x</a>", "a.b@gov.bc.ca"],
    ['<a href="MAILTO:a.b@gov.bc.ca?subject=hi">x</a>', "a.b@gov.bc.ca"],
  ])("extracts the address from %s", (html, email) => {
    expect(emailFromHtml(html)).toBe(email);
  });

  it("returns null when there is no mailto link, instead of echoing the HTML", () => {
    expect(emailFromHtml("<p>Contact the office</p>")).toBeNull();
  });

  it("keeps null as null and empty as empty", () => {
    expect(emailFromHtml(null)).toBeNull();
    expect(emailFromHtml("")).toBe("");
  });
});

describe("buildFixtureEvents", () => {
  it("is deterministic: the resource-links event carries the recorded timestamp, not now()", () => {
    const fx = loadLiveFixtures();
    const linksEvent = (events: ReturnType<typeof buildFixtureEvents>) => events.find((e) => e.aggregateId === "site:resourceLinks")!.data;
    const first = linksEvent(buildFixtureEvents(fx));
    expect(first).toMatchObject({ timestamp: (fx["resource-links"]!.body as { timestamp: string }[])[0]!.timestamp });
    expect(linksEvent(buildFixtureEvents(fx))).toEqual(first);
  });

  it("falls back to a fixed timestamp when there are no recorded resource links", () => {
    const events = buildFixtureEvents({});
    expect(events.find((e) => e.aggregateId === "site:resourceLinks")!.data).toMatchObject({ links: [], timestamp: "1970-01-01T00:00:00Z" });
  });
});
