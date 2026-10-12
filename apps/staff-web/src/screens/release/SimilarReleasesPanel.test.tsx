import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../test/jsonResponse";
import { AI_NOTE, SimilarReleasesPanel } from "./SimilarReleasesPanel";

const VIEW = releaseView();
const RESULT = { key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistry: "Finance", url: "https://site.example.test/releases/2026FIN0002-000002", match: "ai" };

function stub(config: object, similar: () => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return url === "/nrms/api/config" ? jsonResponse(200, config) : similar();
    }),
  );
  return calls;
}
const renderPanel = () => render(<SimilarReleasesPanel view={VIEW} timeZone="America/Vancouver" />);

describe("SimilarReleasesPanel (addendum §7)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing when NRMS has no News API", async () => {
    const calls = stub({ similarAvailable: false, staffAi: false }, () => jsonResponse(500, {}));
    const { container } = renderPanel();
    await waitFor(() => expect(calls).toEqual(["/nrms/api/config"]));
    expect(container).toBeEmptyDOMElement();
  });

  it("runs nothing until Find similar is pressed; with the flag on, the button is described by the AI note", async () => {
    const calls = stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "ai", results: [RESULT] }));
    renderPanel();
    const button = await screen.findByRole("button", { name: "Find similar" });
    expect(button).toHaveAccessibleDescription(AI_NOTE);
    expect(calls).toEqual(["/nrms/api/config"]);
    await userEvent.setup().click(button);
    expect(await screen.findByRole("link", { name: /Clinics budget/ })).toHaveAttribute("href", RESULT.url);
    expect(screen.getByText("AI match")).toBeInTheDocument();
    expect(screen.getByText(/Oct 3, 2026 · Finance/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Found 1 similar published release.");
    expect(calls).toEqual(["/nrms/api/config", `/nrms/api/releases/${VIEW.id}/similar`]);
  });

  it("with the flag off: no AI note, text matches", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [{ ...RESULT, match: "text" }] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText("Text match")).toBeInTheDocument();
    expect(screen.queryByText(AI_NOTE)).not.toBeInTheDocument();
  });

  it("says when AI was asked for but the answer is text matches", async () => {
    stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "text", results: [{ ...RESULT, match: "text" }] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText(/The AI service wasn.t available, so these are text matches\./)).toBeInTheDocument();
  });

  it("says so when nothing is similar", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No similar published releases found."));
  });

  it("shows the server's message on a failure", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(422, { error: "Add a headline or some body text first." }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a headline or some body text first.");
  });

  it("renders an unsafe url as plain text, not a link (M6)", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [{ ...RESULT, match: "text", url: "javascript:alert(1)" }] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText("Clinics budget")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("degrades a malformed item instead of crashing the editor (M2)", async () => {
    // A non-string `url` and an unparseable `publishDate` can't happen once NRMS's own
    // validation is in place, but the panel guards independently rather than trusting the
    // wire shape — a network mock bypasses TypeScript the way a real malformed response would.
    const bad = { ...RESULT, match: "text" as const, url: null as unknown as string, publishDate: "not-a-date" };
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [bad] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText("Clinics budget")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/not-a-date/)).toBeInTheDocument();
  });

  it("has no serious or critical axe violations with results shown", async () => {
    stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "ai", results: [RESULT, { ...RESULT, key: "K2", headline: null, leadMinistry: null, match: "text" }] }));
    const { container } = renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    await screen.findByText("Text match");
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
