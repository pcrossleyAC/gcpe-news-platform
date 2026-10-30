import { describe, expect, it } from "vitest";
import { compile, readManualPages } from "../../../../scripts/manuals-lib.mjs";
import data from "./manuals.generated.json";

describe("generated manuals", () => {
  it("are up to date with docs/manuals", () => {
    // Recompile with the committed file as the previous data. A page whose hash is unchanged keeps
    // its own `changed` date, so any `today` gives the same dates for pages that are current.
    const fresh = compile(readManualPages(), data, "9999-12-31");
    const strip = (d: typeof fresh) => d.pages.map(({ id, hash, html, markdown, manual, order }) => ({ id, hash, html, markdown, manual, order }));
    const stale = JSON.stringify(strip(fresh)) !== JSON.stringify(strip(data));
    expect(stale, "Manual pages changed: run npm run manuals:build").toBe(false);
  });
});
