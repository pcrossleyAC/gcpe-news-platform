import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LIST_QUERY, type ReportJobView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { REPORT_WAIT_MAX_MS, runReport } from "./api";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME, never, renderList, stubFetch, type Call } from "./fixtures";
import { ReportButtons } from "./Reports";

const ID = "AbCdEfGhIjKlMnOpQrSt_-";
const job = (over: Partial<ReportJobView> = {}): ReportJobView => ({ id: ID, report: "look-ahead", status: "ready", error: null, ...over });
const pdf = () => new Response(new Blob(["%PDF-sample"]), { status: 200, headers: { "content-type": "application/pdf" } });
const reports = (page: Element) => within(page.querySelector('[aria-label="Reports (PDF)"]') as HTMLElement);

describe("the list's reports (spec addendum §8.1, §10)", () => {
  let names: string[];
  beforeEach(() => {
    // jsdom has no object URLs; record what the link would save.
    names = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:sample"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an Editor gets Look Ahead, 30/60/90 and Planning; an HQ Administrator also the Exec Look Ahead", async () => {
    stubFetch([]);
    const { container } = renderList();
    await screen.findByText("Sample listed");
    expect(reports(container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Look Ahead", "30/60/90", "Planning"]);
    cleanup();
    stubFetch([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG });
    const hq = renderList();
    await screen.findByText("Sample listed");
    expect(reports(hq.container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Look Ahead", "Exec Look Ahead", "30/60/90", "Planning"]);
  });

  it("runs the report for the list's current query and saves the PDF it gets back", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      other: (url) => (url === "/calendar/api/reports/look-ahead" ? jsonResponse(201, job()) : url === `/calendar/api/reports/jobs/${ID}/pdf` ? pdf() : undefined),
    });
    renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await screen.findByText("The Look Ahead report has downloaded.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/calendar/api/reports/look-ahead")!;
    expect(post.init!.method).toBe("POST");
    expect(JSON.parse(String(post.init!.body))).toEqual({ q: DEFAULT_LIST_QUERY });
    expect(names).toEqual(["LookAhead.pdf"]);
  });

  it("while the server prepares it, says so and holds the buttons, then saves it", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      other: (url) => {
        if (url === "/calendar/api/reports/planning") return jsonResponse(202, job({ report: "planning", status: "running" }));
        if (url === `/calendar/api/reports/jobs/${ID}`) return jsonResponse(200, job({ report: "planning" }));
        if (url === `/calendar/api/reports/jobs/${ID}/pdf`) return pdf();
        return undefined;
      },
    });
    renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Planning" }));
    expect(await screen.findByText("Preparing your Planning report…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look Ahead" })).toBeDisabled();
    expect(await screen.findByText("The Planning report has downloaded.", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/calendar/api/reports/jobs/${ID}`)).toHaveLength(1);
    expect(names).toEqual(["PlanningReport.pdf"]);
    expect(screen.getByRole("button", { name: "Look Ahead" })).toBeEnabled();
  });

  it("a report that failed, or one turned away while others run, says why", async () => {
    stubFetch([], {
      other: (url) =>
        url === "/calendar/api/reports/look-ahead"
          ? jsonResponse(201, job({ status: "failed", error: "The report is too large to prepare: narrow the filter and run it again." }))
          : url === "/calendar/api/reports/30-60-90"
            ? jsonResponse(503, { error: "Other reports are being prepared: try again in a few seconds" })
            : undefined,
    });
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The report is too large to prepare: narrow the filter and run it again.");
    await user.click(screen.getByRole("button", { name: "30/60/90" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Other reports are being prepared: try again in a few seconds"));
    expect(names).toEqual([]);
  });

  it("a report the server forgot while preparing it (a restart) says to run it again", async () => {
    stubFetch([], {
      other: (url) => (url === "/calendar/api/reports/look-ahead" ? jsonResponse(202, job({ status: "running" })) : url === `/calendar/api/reports/jobs/${ID}` ? jsonResponse(404, { error: "not found" }) : undefined),
    });
    await expect(runReport("look-ahead", DEFAULT_LIST_QUERY, { sleep: async () => {} })).rejects.toThrow("The report was lost while it was being prepared. Run it again.");
  });

  it("gives up waiting after five minutes", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/reports") ? jsonResponse(202, job({ status: "running" })) : undefined) });
    let t = 0;
    const out = runReport("look-ahead", DEFAULT_LIST_QUERY, { now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(out).rejects.toThrow("The report is taking too long. Try again later, or narrow the filter.");
    expect(t).toBeGreaterThan(REPORT_WAIT_MAX_MS);
  });

  it("a report still starting shows the same message, for screen readers too", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/reports/look-ahead" ? never() : undefined) });
    const { container } = renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await reports(container).findByRole("status")).toHaveTextContent("Preparing your Look Ahead report…");
  });
});

describe("ReportButtons: no download and no state update once unmounted", () => {
  let calls: string[];
  let errors: unknown[][];
  beforeEach(() => {
    calls = [];
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:sample"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      calls.push(`DOWNLOAD:${this.download}`);
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clicking then unmounting in the same tick suppresses the download, even when the report is ready immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/calendar/api/reports/look-ahead") return jsonResponse(201, job());
        if (url === `/calendar/api/reports/jobs/${ID}/pdf`) return pdf();
        throw new Error(`unhandled: ${url}`);
      }),
    );
    const { unmount } = render(<ReportButtons query={DEFAULT_LIST_QUERY} execLookAhead={false} />);
    // Fire the click synchronously, then unmount in the same tick, before the stubbed fetch's
    // promise chain (startReport, then the PDF fetch) has a chance to run any microtask.
    fireEvent.click(screen.getByRole("button", { name: "Look Ahead" }));
    unmount();
    // Give the pending promise chain every chance to finish.
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((c) => c.startsWith("DOWNLOAD:"))).toBe(false);
    expect(errors).toEqual([]);
  });

  it("stops polling, with no further request, once unmounted mid-poll (regression)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/calendar/api/reports/look-ahead") return jsonResponse(202, job({ status: "running" }));
        if (url === `/calendar/api/reports/jobs/${ID}`) return jsonResponse(200, job({ status: "running" }));
        throw new Error(`unhandled: ${url}`);
      }),
    );
    const { unmount } = render(<ReportButtons query={DEFAULT_LIST_QUERY} execLookAhead={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Look Ahead" }));
    await screen.findByText("Preparing your Look Ahead report…");

    // Let the real REPORT_POLL_MS (1000ms) interval fire at least once, so polling is known live.
    await new Promise((r) => setTimeout(r, 1200));
    const pollsBeforeUnmount = calls.filter((c) => c === `/calendar/api/reports/jobs/${ID}`).length;
    expect(pollsBeforeUnmount).toBeGreaterThanOrEqual(1);

    unmount();

    // Wait through more than two further poll intervals: if cancellation didn't stop the loop,
    // more polls would show up here.
    await new Promise((r) => setTimeout(r, 2500));
    const pollsAfterUnmount = calls.filter((c) => c === `/calendar/api/reports/jobs/${ID}`).length;
    expect(pollsAfterUnmount).toBe(pollsBeforeUnmount);
    expect(errors).toEqual([]);
  }, 10_000);
});
