import { describe, expect, it, vi } from "vitest";
import { ageInBcYears, blueBridgeBanner, isGranvilleOn } from "./site-env";

// Fix round 1 (IMPORTANT 2): legacy stores "true"/"false"; ON iff the trimmed, case-insensitive
// value is exactly "true" — not "any non-empty string".
describe("isGranvilleOn", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    [" true ", true],
    ["false", false],
    ["FALSE", false],
    ["", false],
    [null, false],
    ["on", false],
    ["off", false],
  ] as const)("isGranvilleOn(%j) === %j", (value, expected) => {
    expect(isGranvilleOn(value)).toBe(expected);
  });
});

const DEFAULT_TEXT = {
  message: "ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of {age}.",
  birthDate: "1948-11-14",
};
const at = (iso: string, text = DEFAULT_TEXT, test = false) => blueBridgeBanner("true", new Date(iso), test, text);

describe("ageInBcYears", () => {
  it("counts the birthday on the day, in BC time", () => {
    expect(ageInBcYears(new Date("2026-11-14T06:00:00Z"), "1948-11-14")).toBe(77);
    expect(ageInBcYears(new Date("2026-11-15T06:00:00Z"), "1948-11-14")).toBe(78);
  });
  it("a 29 February birth date counts the birthday from 1 March in a non-leap year", () => {
    expect(ageInBcYears(new Date("2027-02-28T20:00:00Z"), "2000-02-29")).toBe(26);
    expect(ageInBcYears(new Date("2027-03-01T20:00:00Z"), "2000-02-29")).toBe(27);
    expect(ageInBcYears(new Date("2028-02-29T20:00:00Z"), "2000-02-29")).toBe(28);
  });
});

describe("blueBridgeBanner", () => {
  it.each([null, "", "false", "FALSE"])("granville %j gives null whatever the text", (g) => {
    expect(blueBridgeBanner(g, new Date("2026-10-04T18:00:00Z"), false, DEFAULT_TEXT)).toBeNull();
    expect(blueBridgeBanner(g, new Date("2026-10-04T18:00:00Z"), true, { message: "x", birthDate: "bad" })).toBeNull();
  });

  it("granville ' true ' (whitespace, lower-case): banner shown", () => {
    expect(blueBridgeBanner(" true ", new Date("2026-10-04T18:00:00Z"), false, DEFAULT_TEXT)).toContain("ALERT:");
  });

  it("BC default text on 2026-11-13 (BC) reads 'at the age of 77.' and on 2026-11-14 (BC) '78.', including at 2026-11-14T06:30Z (still the evening of the 13th in BC; the brief's 07:30Z is the 14th under this Node's tzdata, which has BC on PDT in Nov 2026)", () => {
    expect(at("2026-11-13T20:00:00Z")).toBe("ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of 77.");
    expect(at("2026-11-14T06:30:00Z")).toContain("age of 77.");
    expect(at("2026-11-14T18:00:00Z")).toBe("ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of 78.");
  });

  it("every {age} is replaced; a message with no {age} is returned as written; the TEST — prefix stays", () => {
    expect(at("2026-10-04T18:00:00Z", { message: "{age} and {age}", birthDate: "1948-11-14" })).toBe("77 and 77");
    expect(at("2026-10-04T18:00:00Z", { message: "No age here.", birthDate: "1948-11-14" })).toBe("No age here.");
    expect(at("2026-10-04T18:00:00Z", DEFAULT_TEXT, true)?.startsWith("TEST — ALERT:")).toBe(true);
  });

  it("an unparseable birth date leaves {age} out and logs once per process", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { message: "Aged {age}.", birthDate: "soon" };
    expect(at("2026-10-04T18:00:00Z", bad)).toBe("Aged .");
    expect(at("2026-10-05T18:00:00Z", bad)).toBe("Aged .");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
