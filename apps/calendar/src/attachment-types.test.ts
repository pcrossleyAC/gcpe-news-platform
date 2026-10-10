import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT, ATTACHMENT_EXTENSIONS } from "@gcpe/calendar-contract";
import { ATTACHMENT_TYPES } from "@gcpe/storage";

describe("the editor's file picker and the server's check", () => {
  it("name exactly the same extensions", () => {
    expect([...ATTACHMENT_EXTENSIONS].sort()).toEqual(Object.keys(ATTACHMENT_TYPES).sort());
    expect(ATTACHMENT_ACCEPT.split(",")).toEqual(ATTACHMENT_EXTENSIONS.map((e) => `.${e}`));
  });
});
