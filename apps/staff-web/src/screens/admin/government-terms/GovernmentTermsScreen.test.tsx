import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { GovernmentTermList, GovernmentTermView } from "@gcpe/nrms-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { GovernmentTermsScreen } from "./GovernmentTermsScreen";

const term = (over: Partial<GovernmentTermView>): GovernmentTermView => ({
  id: "11111111-1111-4111-8111-111111111111",
  slug: "2024-onward",
  label: null,
  startDate: "2024-11-18",
  endDate: null,
  status: "current",
  legacyArchiveUrl: null,
  legacyId: null,
  releaseCount: 12,
  ...over,
});

const PAST = term({ id: "22222222-2222-4222-8222-222222222222", slug: "2017-2024", label: "Horgan era", startDate: "2017-07-18", endDate: "2024-11-17", status: "past", releaseCount: 300 });
const CURRENT = term({});
const SCHEDULED = term({ id: "33333333-3333-4333-8333-333333333333", slug: "2028-onward", startDate: "2028-11-20", status: "scheduled", releaseCount: 0 });
const UNDATED = term({ id: "44444444-4444-4444-8444-444444444444", slug: "old-archive", label: "Old archive", startDate: null, endDate: null, status: "undated", releaseCount: 5 });

let failures: Record<string, () => Response> = {};

function stub(roles: string[], calls: { url: string; init?: RequestInit }[], terms: GovernmentTermView[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const failure = failures[`${init?.method ?? "GET"} ${url}`];
      if (failure) return failure();
      if (url === "/core/auth/session")
        return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/government-terms" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { startDate: string };
        const created = term({ id: "55555555-5555-4555-8555-555555555555", slug: "new", startDate: body.startDate, status: "scheduled", releaseCount: 0 });
        terms = [...terms, created];
        return jsonResponse(201, created);
      }
      if (url === "/nrms/api/government-terms")
        return jsonResponse(200, { today: "2026-10-27", terms } satisfies GovernmentTermList);
      const m = /^\/nrms\/api\/government-terms\/(.+)$/.exec(url);
      if (m && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as Partial<GovernmentTermView>;
        terms = terms.map((t) => (t.id === m[1] ? { ...t, ...body } : t));
        return jsonResponse(200, terms.find((t) => t.id === m[1]));
      }
      if (m && init?.method === "DELETE") {
        terms = terms.filter((t) => t.id !== m[1]);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <GovernmentTermsScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

const rowOf = async (text: RegExp | string) => (await screen.findByText(text)).closest("tr")!;

describe("GovernmentTermsScreen", () => {
  afterEach(() => {
    cleanup();
    failures = {};
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("tells anyone but a Core.Admin they can't use it, without loading terms", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["NRMS.SiteEditor"], calls, [CURRENT]);
    renderScreen();
    await screen.findByText(/don.t have permission/);
    expect(calls.some((c) => c.url === "/nrms/api/government-terms")).toBe(false);
  });

  it("shows generated ranges and statuses", async () => {
    stub(["Core.Admin"], [], [PAST, CURRENT, SCHEDULED]);
    renderScreen();
    const current = await rowOf("November 18, 2024 to current date");
    expect(within(current).getByText("Current")).toBeTruthy();
    expect(within(await rowOf("July 18, 2017 to November 17, 2024")).getByText("Past")).toBeTruthy();
    const scheduled = await rowOf("Scheduled: starts November 20, 2028");
    expect(within(scheduled).getByText("Scheduled")).toBeTruthy();
  });

  it('says "Needs a start date" for undated rows', async () => {
    stub(["Core.Admin"], [], [CURRENT, UNDATED]);
    renderScreen();
    const row = await rowOf("Needs a start date");
    expect(within(row).getByText("Old archive")).toBeTruthy();
  });

  it("start a new term asks, confirms and saves", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [PAST, CURRENT]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start new government term" }));
    await user.type(screen.getByLabelText(/Start date/), "2028-11-20");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByText(
        "Start a new government term on November 20, 2028? The current term will end November 19, 2028. Releases published from that day are listed under the new term.",
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/nrms/api/government-terms");
    expect(JSON.parse(post.init!.body as string)).toEqual({ startDate: "2028-11-20", label: null });
    expect((await screen.findByRole("status")).textContent).toBe("Saved. The archive switches to the new term on November 20, 2028.");
    await screen.findByText("Scheduled: starts November 20, 2028");
    expect(screen.queryByRole("form", { name: "Start a new government term" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start new government term" }));
  });

  it("sends the label when one is typed", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [CURRENT]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start new government term" }));
    await user.type(screen.getByLabelText(/Start date/), "2028-11-20");
    await user.type(screen.getByLabelText(/Name/), "  Next government ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("status");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ startDate: "2028-11-20", label: "Next government" });
  });

  it("does not continue without a date, and going back keeps what was typed", async () => {
    stub(["Core.Admin"], [], [CURRENT]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start new government term" }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/Start date/), "2028-11-20");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect((screen.getByLabelText(/Start date/) as HTMLInputElement).value).toBe("2028-11-20");
  });

  it("shows the 409 message from the server inline", async () => {
    stub(["Core.Admin"], [], [CURRENT, SCHEDULED]);
    failures["POST /nrms/api/government-terms"] = () => jsonResponse(409, { error: "A new term must start after November 20, 2028." });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start new government term" }));
    await user.type(screen.getByLabelText(/Start date/), "2027-01-01");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    const form = screen.getByRole("form", { name: "Start a new government term" });
    expect((await within(form).findByRole("alert")).textContent).toBe("A new term must start after November 20, 2028.");
    expect(within(form).getByLabelText(/Start date/)).toBeTruthy();
  });

  it("edit label and legacy URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [PAST, CURRENT]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit 2024-onward" }));
    const form = screen.getByRole("form", { name: "Edit 2024-onward" });
    await user.type(within(form).getByLabelText(/Name/), "Eby government");
    await user.type(within(form).getByLabelText(/Old archive web address/), "https://archive.news.gov.bc.ca/2024");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe(`/nrms/api/government-terms/${CURRENT.id}`);
    expect(JSON.parse(patch.init!.body as string)).toEqual({ label: "Eby government", legacyArchiveUrl: "https://archive.news.gov.bc.ca/2024" });
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Eby government" })));
  });

  it("lets an undated term be given a start date, and shows an edit 409", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [CURRENT, UNDATED]);
    failures[`PATCH /nrms/api/government-terms/${UNDATED.id}`] = () => jsonResponse(409, { error: "Another term already starts on that date." });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Old archive" }));
    const form = screen.getByRole("form", { name: "Edit Old archive" });
    await user.type(within(form).getByLabelText(/Start date/), "2024-11-18");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Another term already starts on that date.");
    expect(JSON.parse(calls.find((c) => c.init?.method === "PATCH")!.init!.body as string)).toEqual({ startDate: "2024-11-18" });
  });

  it("offers Delete only on scheduled rows, and confirms first", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls, [PAST, CURRENT, SCHEDULED]);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByText("Scheduled: starts November 20, 2028");
    expect(screen.getAllByRole("button", { name: /^Delete/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Delete 2028-onward" }));
    expect(screen.getByText(/Delete the term starting November 20, 2028\?/)).toBeTruthy();
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByText("Scheduled: starts November 20, 2028")).toBeNull());
    expect(calls.find((c) => c.init?.method === "DELETE")!.url).toBe(`/nrms/api/government-terms/${SCHEDULED.id}`);
    expect((await screen.findByRole("status")).textContent).toMatch(/deleted/);
  });

  it("returns focus to Delete when the delete is cancelled", async () => {
    stub(["Core.Admin"], [], [CURRENT, SCHEDULED]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete 2028-onward" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete 2028-onward" })));
  });

  it("shows a load failure", async () => {
    stub(["Core.Admin"], [], []);
    failures["GET /nrms/api/government-terms"] = () => jsonResponse(500, { error: "boom" });
    renderScreen();
    await screen.findByText("Couldn't load government terms.");
  });
});
