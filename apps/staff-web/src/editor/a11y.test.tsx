/** Fix round 1 (3f Task 4), finding 3: axe clean for the body editor with its toolbar visible
 * (i.e. not read-only) — same helper/pattern as apps/staff-web/src/a11y.test.tsx. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("in full screen with blocks showing (C323)", async () => {
    const { container } = render(
      <BodyEditor id="body" label="Body" value="<p>One</p><ul><li><p>Two</p></li></ul>" onChange={() => {}} readOnly={false} />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show blocks" }));
    await user.click(screen.getByRole("button", { name: "Full screen" }));
    await screen.findByRole("button", { name: "Move down" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
