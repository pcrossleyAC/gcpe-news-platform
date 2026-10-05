import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { SideBar } from "./SideBar";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SideBar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the reference block, view links, email copy and history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/config")) return jsonResponse(200, { publicSiteUrl: "" });
        if (url.includes("/log")) return jsonResponse(200, []);
        if (url.includes("/publications")) return jsonResponse(200, []);
        return jsonResponse(200, {});
      }),
    );
    render(<SideBar view={releaseView()} />);
    expect(screen.getByText("Key")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a copy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
  });
});
