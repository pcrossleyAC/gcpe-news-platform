import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { site } from "../../test/fixtures";
import { renderArchiveIndex, renderArchiveMonth } from "./archive";

describe("archives", () => {
  it("the index groups months by year, newest first, with counts", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 12 }, { month: "2026-09", count: 1 }, { month: "2025-12", count: 3 }], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News archive");
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["2026", "2025"]);
    expect([...doc.querySelectorAll("main li")].map((li) => li.textContent)).toEqual(["October 2026 (12 posts)", "September 2026 (1 post)", "December 2025 (3 posts)"]);
    expect(doc.querySelector('a[href="/archive/2026/10/"]')).not.toBeNull();
  });
  it("an empty index says so", () => {
    expect(expectAccessibleStructure(renderArchiveIndex([], site, {})).querySelector("main p")?.textContent).toBe("Nothing has been published yet.");
  });
  it("a month lists its posts in the given order, escaped", () => {
    const doc = expectAccessibleStructure(renderArchiveMonth("2026-10", [
      { key: "B", kind: "releases", headline: "B <i>", summary: null, publishDate: "2026-10-05T09:00:00-07:00", month: "2026-10", categories: [] },
      { key: "A", kind: "stories", headline: "A", summary: "S", publishDate: "2026-10-01T09:00:00-07:00", month: "2026-10", categories: [] },
    ], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News from October 2026");
    expect([...doc.querySelectorAll("main ul.post-list a")].map((a) => a.textContent)).toEqual(["B <i>", "A"]);
    // Scoped to main: the header nav also links to /archive/ ("Archive"), which a bare
    // a[href="/archive/"] selector would match first.
    expect(doc.querySelector('main a[href="/archive/"]')?.textContent).toBe("All months");
  });
});
