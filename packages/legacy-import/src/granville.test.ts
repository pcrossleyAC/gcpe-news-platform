import { describe, expect, it } from "vitest";
import { isGranvilleOn, normalizeGranville } from "./granville";

describe("isGranvilleOn", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    [" true ", true],
    ["false", false],
    ["FALSE", false],
    ["", false],
    [null, false],
    [undefined, false],
    ["off", false],
  ] as const)("isGranvilleOn(%j) === %j", (value, expected) => {
    expect(isGranvilleOn(value)).toBe(expected);
  });
});

describe("normalizeGranville", () => {
  it.each([
    ["true", "true"],
    ["TRUE", "true"],
    [" true ", "true"],
    ["false", null],
    ["FALSE", null],
    ["", null],
    [null, null],
    [undefined, null],
    ["off", null],
  ] as const)("normalizeGranville(%j) === %j", (raw, expected) => {
    expect(normalizeGranville(raw)).toBe(expected);
  });
});
