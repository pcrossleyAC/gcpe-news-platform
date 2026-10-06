import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
  it("escapes & first, so existing entities are escaped rather than double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
  it("leaves other text untouched", () => {
    expect(escapeHtml("Clinics open — {{name}} é")).toBe("Clinics open — {{name}} é");
  });
});
