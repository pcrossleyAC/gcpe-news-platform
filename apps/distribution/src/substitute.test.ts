import { describe, expect, it } from "vitest";
import { substitute } from "./substitute";
describe("substitute", () => {
  it("replaces known placeholders and leaves unknown ones", () => {
    expect(substitute("Hi {{name}} {{other}}", { name: "Alex" }, "text")).toBe("Hi Alex {{other}}");
  });
  it("escapes values in html mode only", () => {
    expect(substitute("<a href=\"{{u}}\">", { u: "x\"><script>" }, "html")).toBe("<a href=\"x&quot;&gt;&lt;script&gt;\">");
    expect(substitute("{{u}}", { u: "<b>" }, "text")).toBe("<b>");
  });
  it("strips CR/LF from header values", () => {
    expect(substitute("<{{u}}>", { u: "https://x\r\nBcc: evil@x.com" }, "header")).toBe("<https://xBcc: evil@x.com>");
  });
  it("does not re-expand placeholders that appear inside values", () => {
    expect(substitute("{{a}}", { a: "{{b}}", b: "boom" }, "text")).toBe("{{b}}");
  });
});
