import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { jsonResponse } from "../../../test/jsonResponse";
import { FeaturedScreen } from "./FeaturedScreen";
import type { FeaturedWhereRow } from "./types";

const ROWS: FeaturedWhereRow[] = [
  { kind: "home", key: "default", label: "Home", top: { id: "r1", key: "r1", headline: "Big news" }, feature: null },
  { kind: "ministries", key: "health", label: "Health", top: null, feature: { id: "r2", key: "r2", headline: "Clinics open" } },
];

describe("FeaturedScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a read-only table of what's featured where, with no write controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/nrms/api/site/features" ? jsonResponse(200, ROWS) : jsonResponse(200, {}))));
    render(<FeaturedScreen />);
    await screen.findByRole("heading", { name: "What’s featured where", level: 1 });
    // I5: document.title matches the h1.
    expect(document.title).toBe("What’s featured where — GCPE News Staff");
    expect(screen.getByRole("cell", { name: "Big news" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Clinics open" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a friendly message when nothing is featured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    render(<FeaturedScreen />);
    await screen.findByText("Nothing is currently Top or Feature anywhere.");
  });
});
