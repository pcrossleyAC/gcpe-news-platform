/** Fix round 1 (3f Task 4), finding 3: axe clean for the body editor with its toolbar visible
 * (i.e. not read-only) — same helper/pattern as apps/staff-web/src/a11y.test.tsx. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { BodyEditor } from "./BodyEditor";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility (constraints.md: no serious/critical axe violations) — BodyEditor", () => {
  afterEach(cleanup);

  it("with the toolbar visible", async () => {
    const { container } = render(
      <BodyEditor id="body" label="Body" value="<p>Hello <strong>world</strong></p>" onChange={() => {}} readOnly={false} />,
    );
    await screen.findByRole("toolbar", { name: "Body formatting" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
