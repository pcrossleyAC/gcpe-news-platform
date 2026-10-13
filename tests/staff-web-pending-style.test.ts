import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("../apps/staff-web/src/styles/global.css", import.meta.url)), "utf8");

describe("a pending staff-web Button has its own visible style", () => {
  it("styles [data-pending] without hiding focus or disabling the pointer", () => {
    const rule = CSS.match(/\.bcds-react-aria-Button\[data-pending\]\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    // A visible cue beyond the aria-disabled announcement a screen reader already gets.
    expect(body).toMatch(/cursor:\s*progress/);
    // Must never be made to look unfocusable the way a truly disabled control is.
    expect(body).not.toMatch(/pointer-events:\s*none/);
    expect(body).not.toMatch(/outline:\s*none/);
    expect(body).not.toMatch(/\bdisplay:\s*none/);
  });
});
