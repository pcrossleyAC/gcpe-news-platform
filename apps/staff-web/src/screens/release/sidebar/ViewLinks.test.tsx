import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { ViewLinks } from "./ViewLinks";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ViewLinks", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("View PDF always points at the PDF endpoint, opened in a new tab", () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { publicSiteUrl: "" })));
    const view = releaseView({ key: null });
    render(<ViewLinks view={view} />);
    const pdfLink = screen.getByRole("link", { name: "View PDF" });
    expect(pdfLink).toHaveAttribute("href", `/nrms/api/releases/${view.id}/pdf`);
    expect(pdfLink).toHaveAttribute("target", "_blank");
  });

  it("no key yet: no View on site link", () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { publicSiteUrl: "https://news.gov.bc.ca" })));
    render(<ViewLinks view={releaseView({ key: null })} />);
    expect(screen.queryByRole("link", { name: "View on site" })).not.toBeInTheDocument();
  });

  it("View on site builds publicSiteUrl/<POST_KIND>/<key>", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { publicSiteUrl: "https://news.gov.bc.ca/" })));
    render(<ViewLinks view={releaseView({ key: "clinics-open", type: "release" })} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "View on site" })).toHaveAttribute("href", "https://news.gov.bc.ca/releases/clinics-open"));
  });
});
