import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ICONS, icon, type IconId } from "./icons";

const sprite = readFileSync(new URL("../assets/site/icons.svg", import.meta.url), "utf8");

describe("icons", () => {
  it("icons.svg has a <symbol id='i-<id>'> with a viewBox for every ICONS id, and the CC BY 4.0 attribution comment", () => {
    const doc = new JSDOM(sprite, { contentType: "image/svg+xml" }).window.document;
    for (const id of Object.keys(ICONS)) {
      const sym = doc.getElementById(`i-${id}`);
      expect(sym?.tagName, id).toBe("symbol");
      expect(sym?.getAttribute("viewBox"), id).toMatch(/^0 0 \d+ \d+$/);
      expect(sym?.querySelector("path")?.getAttribute("d"), id).toBeTruthy();
    }
    expect(doc.querySelectorAll("symbol").length).toBe(Object.keys(ICONS).length);
    expect(sprite).toMatch(/CC BY 4\.0/);
    expect(sprite).toContain("fontawesome.com/license/free");
  });

  it("icon() is aria-hidden, not focusable, and carries the base path", () => {
    expect(icon("search", "https://x.test/news")).toBe(
      '<svg class="icon" aria-hidden="true" focusable="false"><use href="https://x.test/news/assets/site/icons.svg#i-search"></use></svg>',
    );
    expect(icon("rss" satisfies IconId, "", "icon icon-lg")).toContain('class="icon icon-lg"');
  });
});
