import { describe, expect, it } from "vitest";
import { orgKeyFromName } from "./org-key";

describe("orgKeyFromName", () => {
  it.each([
    ["Citizens' Services", "citizens-services"],
    ["Tourism, Arts, Culture and Sport", "tourism-arts-culture-and-sport"],
    ["Post-Secondary Education and Future Skills", "post-secondary-education-and-future-skills"],
    ["  Office of the Premier ", "office-of-the-premier"],
    ["!!!", ""],
  ])("%s -> %s", (name, key) => {
    expect(orgKeyFromName(name)).toBe(key);
  });
});
