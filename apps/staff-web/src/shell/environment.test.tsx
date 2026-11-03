import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EnvironmentBanner, resetEnvironmentForTests, withEnvironment } from "./environment";
import { jsonResponse } from "../../test/jsonResponse";

const answer = (name: string | null) => vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { name })));

describe("environment banner (C331)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetEnvironmentForTests();
    document.title = "";
  });

  it("a DEV site gets a purple strip naming it, from GET /core/environment", async () => {
    answer("DEV");
    render(<EnvironmentBanner />);
    const strip = await screen.findByText("DEV site");
    expect(strip.closest("p")).toHaveClass("gcpe-env-banner", "gcpe-env-banner--dev");
    expect(strip.closest("p")).toHaveTextContent("DEV site: changes here don’t reach the live news site.");
    expect(fetch).toHaveBeenCalledWith("/core/environment", { cache: "no-store" });
  });

  it("TEST and any other name get their own colours", async () => {
    answer("TEST");
    render(<EnvironmentBanner />);
    expect((await screen.findByText("TEST site")).closest("p")).toHaveClass("gcpe-env-banner--test");
    cleanup();
    resetEnvironmentForTests();
    answer("UAT");
    render(<EnvironmentBanner />);
    expect((await screen.findByText("UAT site")).closest("p")).toHaveClass("gcpe-env-banner--other");
  });

  it("real production (null), or no answer at all: no strip", async () => {
    answer(null);
    const { container } = render(<EnvironmentBanner />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    cleanup();
    resetEnvironmentForTests();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const second = render(<EnvironmentBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(second.container).toBeEmptyDOMElement();
  });

  it("the tab title starts with the name, once, including a title set before it arrived", async () => {
    document.title = "Drafts — GCPE News Staff";
    answer("TEST");
    render(<EnvironmentBanner />);
    await screen.findByText("TEST site");
    expect(document.title).toBe("[TEST] Drafts — GCPE News Staff");
    expect(withEnvironment("[TEST] Drafts — GCPE News Staff")).toBe("[TEST] Drafts — GCPE News Staff");
    expect(withEnvironment("Forecast — GCPE News Staff")).toBe("[TEST] Forecast — GCPE News Staff");
  });
});
