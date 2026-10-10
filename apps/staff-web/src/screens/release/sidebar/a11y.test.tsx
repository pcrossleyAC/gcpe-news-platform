/** Fix round 1 (3f Task 4), finding 3: axe clean for the side bar and History with "Show all"
 * on — same helper/pattern as apps/staff-web/src/a11y.test.tsx. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { SideBar } from "./SideBar";
import { HistorySection } from "./HistorySection";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const VIEW = releaseView({ key: "clinics-open", reference: "NEWS-12345", activityId: 123 });

describe("accessibility (constraints.md: no serious/critical axe violations) — side bar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("SideBar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/config")) return jsonResponse(200, { publicSiteUrl: "https://news.gov.bc.ca" });
        if (url.includes("/log")) return jsonResponse(200, [{ at: "Today 2:30 PM", actorName: "Pat", text: "Approved" }]);
        if (url.includes("/publications")) return jsonResponse(200, [{ id: 1, publishedAt: "Today 3:00 PM", actorName: "Pat" }]);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(
      <SessionProvider>
        <SideBar view={VIEW} timeZone="America/Vancouver" />
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "History" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("HistorySection with Show all on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/log")) return jsonResponse(200, [{ at: "Today 2:30 PM", actorName: "Pat", text: "Edited the headline" }]);
        return jsonResponse(200, [{ id: 1, publishedAt: "Today 3:00 PM", actorName: "Pat" }]);
      }),
    );
    const { container } = render(<HistorySection view={VIEW} timeZone="America/Vancouver" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Show all" }));
    await screen.findByText(/Edited the headline/);
    expect(await seriousViolations(container)).toEqual([]);
  });
});
