import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { OperationsScreen } from "./OperationsScreen";
import { expectLeaveAsks, expectLeaveFree, renderGuarded } from "../../../test/leaveGuard";
import type { OperationsStatus, OutgoingGroup } from "./types";

const OPS: OperationsStatus = {
  nod: { paused: false, lastDigestCutoff: "2026-10-07T00:00:00.000Z" },
  distribution: { paused: false },
  bounceSource: "fake",
  bounceSummary: { address: "server@example.test", from: "server" },
  softCodesCounted: [],
  purge: {
    enabled: false,
    preview: { pendingSubscribers: 0, endedSubscribers: 3, unusedLinks: 2, expiredSendLinks: 40 },
    lastRun: null,
    nextRunAt: "2026-10-08T10:00:00.000Z",
  },
  emergencyFeed: {
    url: "https://emergency.example.test/feed.xml",
    checkedAt: "2026-10-07T18:00:00.000Z",
    result: { at: "2026-10-07T18:00:00.000Z", ok: true, seeded: false, inFeed: 2, created: 1, updated: 0, skipped: 0, failed: 0, error: null },
  },
  opsEmailSet: true,
  outgoing: { held: { emails: 0, releases: 0, oldestAt: null, groups: [] }, failed: [] },
};

const J1 = "11111111-1111-1111-1111-111111111111";
const J2 = "22222222-2222-2222-2222-222222222222";
const J3 = "33333333-3333-3333-3333-333333333333";
const J4 = "44444444-4444-4444-4444-444444444444";
const J5 = "55555555-5555-5555-5555-555555555555";
const group = (over: Partial<OutgoingGroup>): OutgoingGroup => ({
  jobIds: [], kind: "as_it_happens", title: null, itemKey: null, digestCutoff: null, releases: 1, emails: 0,
  createdAt: "2026-10-07T17:00:00.000Z", attempts: 0, lastError: null, ...over,
});
/** Paused, with an As it happens email, a two-job digest run and a failed media email. */
const HELD: OperationsStatus = {
  ...OPS,
  nod: { paused: true, lastDigestCutoff: "2026-10-07T00:00:00.000Z" },
  outgoing: {
    held: {
      emails: 1205,
      releases: 3,
      oldestAt: "2026-09-25T17:00:00.000Z",
      groups: [
        group({ jobIds: [J1], title: "Budget 2027", itemKey: "r1", emails: 1200, createdAt: "2026-09-25T17:00:00.000Z" }),
        group({ jobIds: [J2, J3], kind: "digest", digestCutoff: "2026-10-01T00:00:00.000Z", releases: 2, emails: 5, createdAt: "2026-10-01T00:00:00.000Z", attempts: 1, lastError: "Distribution 503: unavailable" }),
      ],
    },
    failed: [group({ jobIds: [J4], kind: "media", title: "Wildfire update", itemKey: "r2", emails: 40, attempts: 3, lastError: "Distribution 400: bad request" })],
  },
};

type Call = { url: string; method: string; body: unknown };
function stub(
  roles: string[],
  ops: OperationsStatus = OPS,
  opts: {
    load?: () => Response;
    upload?: () => Response;
    softCodes?: () => Response | Promise<Response>;
    purge?: () => Response | Promise<Response>;
    bounceAddress?: () => Response | Promise<Response>;
    cancel?: () => Response | Promise<Response>;
    resume?: () => Response | Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/operations") return opts.load?.() ?? jsonResponse(200, ops);
    if (url === "/nod/api/operations/purge") return opts.purge?.() ?? jsonResponse(200, { changed: true, purge: { ...ops.purge, enabled: true } });
    if (url.endsWith("/pause")) return jsonResponse(200, { paused: true, changed: true });
    if (url === "/nod/api/settings/resume") return opts.resume?.() ?? jsonResponse(200, { paused: false, changed: true, released: { emails: 0, releases: 0 } });
    if (url === "/nod/api/operations/held-email/cancel") return opts.cancel?.() ?? jsonResponse(200, { cancelledJobs: 1, cancelledEmails: 1200 });
    if (url === "/nod/api/operations/bounce-summary-address") return opts.bounceAddress?.() ?? jsonResponse(200, { changed: true, bounceSummary: { address: "staff@example.test", from: "setting" } });
    if (url === "/nod/api/operations/bounce-soft-codes") return opts.softCodes?.() ?? jsonResponse(200, { changed: true, softCodesCounted: ["4.2.2", "4.4.7"] });
    if (url === "/nod/api/bounces/inbox") return opts.upload?.() ?? jsonResponse(201, { id: "b1" });
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/operations"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/operations" element={<OperationsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("OperationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("an Editor is told it's for admins and nothing is fetched", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    expect(await screen.findByText("You don’t have permission to use Operations.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/nod/api/operations")).toBe(false);
    await waitFor(() => expect(document.title).toBe("Operations — GCPE News Staff"));
  });

  it("pausing NoD asks first, then posts and reloads", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const nod = await screen.findByRole("region", { name: "News On Demand sending" });
    expect(within(nod).getByText("Running")).toBeInTheDocument();
    await user.click(within(nod).getByRole("button", { name: "Pause News On Demand sending" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nothing is dropped");
    expect(dialog).toHaveTextContent("The operations inbox is emailed.");
    await user.click(within(dialog).getByRole("button", { name: "Confirm pause" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/settings/pause", method: "POST", body: undefined }));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("N3: while paused, shows what's held per release, how many and since when; resuming says how many go out", async () => {
    stub(["NoD.Admin"], HELD);
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    expect(out).toHaveTextContent("Held while paused: 1,205 emails for 3 releases. The oldest has waited");
    const held = within(out).getByRole("table", { name: "Held news email" });
    expect(within(held).getByRole("row", { name: /^Budget 2027 As it happens 1,200 / })).toBeInTheDocument();
    expect(within(held).getByRole("row", { name: /^Daily digest of .*2 releases Daily digest 5 .*Tried 1 time\. Last error: Distribution 503: unavailable/ })).toBeInTheDocument();
    const nod = screen.getByRole("region", { name: "News On Demand sending" });
    await user.click(within(nod).getByRole("button", { name: "Resume News On Demand sending" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("1,205 held emails for 3 releases start going out straight away. The oldest has waited");
    expect(dialog).toHaveTextContent("To stop some of them, choose Cancel and cancel them under Outgoing news email first.");
  });

  it("review M4: the resume question counts what's held when it opens, and the result says what actually went", async () => {
    let loads = 0;
    const fresher: OperationsStatus = { ...HELD, outgoing: { ...HELD.outgoing, held: { ...HELD.outgoing.held, emails: 1300, releases: 4 } } };
    const calls = stub(["NoD.Admin"], HELD, {
      load: () => jsonResponse(200, ++loads === 1 ? HELD : fresher),
      resume: () => jsonResponse(200, { paused: false, changed: true, released: { emails: 1310, releases: 5 } }),
    });
    renderIt();
    const user = userEvent.setup();
    const nod = await screen.findByRole("region", { name: "News On Demand sending" });
    await user.click(within(nod).getByRole("button", { name: "Resume News On Demand sending" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveTextContent("1,300 held emails for 4 releases start going out straight away."));
    await user.click(within(dialog).getByRole("button", { name: "Confirm resume" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nod/api/settings/resume")).toBe(true));
    expect(await screen.findByText("News On Demand sending resumed. 1,310 held emails for 5 releases are going out now.")).toBeInTheDocument();
  });

  it("N3: a failed send is shown with what went wrong, and what to do", async () => {
    stub(["NoD.Admin"], HELD);
    renderIt();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    const failed = within(out).getByRole("table", { name: "Failed news email" });
    expect(within(failed).getByRole("row", { name: /^Wildfire update Media list 40 .*Gave up after 3 tries\. What went wrong: Distribution 400: bad request/ })).toBeInTheDocument();
    expect(out).toHaveTextContent("Failed email isn’t sent again by itself.");
  });

  it("N3: cancelling one release's held email asks first, naming how many and which, then posts its jobs and reloads", async () => {
    const calls = stub(["NoD.Admin"], HELD);
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    await user.click(within(out).getByRole("button", { name: "Cancel held email: Budget 2027 (As it happens)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Cancel held email?");
    expect(dialog).toHaveTextContent("1,200 emails for 1 release won’t be sent. This can’t be undone.");
    expect(within(dialog).getByRole("listitem")).toHaveTextContent("Budget 2027 (As it happens): 1,200 emails");
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Cancel held email" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/held-email/cancel", method: "POST", body: { jobIds: [J1] } }));
    expect(await screen.findByText("Cancelled 1,200 held emails.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("N3: Cancel all held email names every release and posts every job", async () => {
    const calls = stub(["NoD.Admin"], HELD, { cancel: () => jsonResponse(200, { cancelledJobs: 3, cancelledEmails: 1205 }) });
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    await user.click(within(out).getByRole("button", { name: "Cancel all held email" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("1,205 emails for 3 releases won’t be sent.");
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Budget 2027 (As it happens): 1,200 emails",
      expect.stringMatching(/^Daily digest of .*, 2 releases \(Daily digest\): 5 emails$/),
    ]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel held email" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/held-email/cancel", method: "POST", body: { jobIds: [J1, J2, J3] } }));
  });

  it("review M3: a partial cancel says some had already started going out", async () => {
    stub(["NoD.Admin"], HELD, { cancel: () => jsonResponse(200, { cancelledJobs: 2, cancelledEmails: 5 }) });
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    await user.click(within(out).getByRole("button", { name: "Cancel all held email" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel held email" }));
    expect(await screen.findByText("Cancelled 5 held emails. Some had already started going out, so they weren’t cancelled.")).toBeInTheDocument();
  });

  it("review M5: cancelling held emergency alerts says so in the question", async () => {
    const alert = group({ jobIds: [J5], kind: "emergency", title: "Evacuation order", itemKey: "e1", emails: 300 });
    stub(["NoD.Admin"], { ...HELD, outgoing: { ...HELD.outgoing, held: { ...HELD.outgoing.held, groups: [...HELD.outgoing.held.groups, alert] } } });
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    await user.click(within(out).getByRole("button", { name: "Cancel all held email" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("This includes 1 emergency alert.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await user.click(within(out).getByRole("button", { name: "Cancel held email: Budget 2027 (As it happens)" }));
    expect(await screen.findByRole("alertdialog")).not.toHaveTextContent("emergency alert.");
  });

  it("N3: if sending was resumed meanwhile, the dialog says nothing was cancelled", async () => {
    stub(["NoD.Admin"], HELD, { cancel: () => jsonResponse(409, { error: "not-paused" }) });
    renderIt();
    const user = userEvent.setup();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    await user.click(within(out).getByRole("button", { name: "Cancel all held email" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel held email" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("News On Demand sending isn’t paused, so nothing was cancelled.");
  });

  it("N3: while running, nothing can be cancelled; with nothing waiting it says so", async () => {
    stub(["NoD.Admin"], { ...HELD, nod: { ...HELD.nod, paused: false }, outgoing: { ...HELD.outgoing, held: { ...HELD.outgoing.held, groups: [HELD.outgoing.held.groups[1]!] } } });
    renderIt();
    const out = await screen.findByRole("region", { name: "Outgoing news email" });
    expect(out).toHaveTextContent("Waiting to go out:");
    expect(within(out).queryByRole("button", { name: /Cancel/ })).toBeNull();
    cleanup();
    stub(["NoD.Admin"]);
    renderIt();
    expect(await screen.findByText("Nothing is waiting to go out.")).toBeInTheDocument();
    expect(screen.getByText("No news email failed in the last 30 days.")).toBeInTheDocument();
    const nod = screen.getByRole("region", { name: "News On Demand sending" });
    expect(within(nod).queryByText(/held emails for/)).toBeNull();
  });

  it("with no operations inbox set up, the pause and resume dialogs say no one is emailed", async () => {
    stub(["NoD.Admin"], { ...OPS, opsEmailSet: false, distribution: { paused: true } });
    renderIt();
    const user = userEvent.setup();
    const nod = await screen.findByRole("region", { name: "News On Demand sending" });
    await user.click(within(nod).getByRole("button", { name: "Pause News On Demand sending" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("No one is emailed about it.");
    expect(dialog).not.toHaveTextContent("operations inbox");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const dist = screen.getByRole("region", { name: "Distribution" });
    await user.click(within(dist).getByRole("button", { name: /^Resume/ }));
    dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("No one is emailed about it.");
    expect(dialog).not.toHaveTextContent("operations inbox");
  });

  it("an off purge doesn't show a last run", async () => {
    stub(["NoD.Admin"], {
      ...OPS,
      purge: { ...OPS.purge, lastRun: { cutoff: "2026-10-07T10:00:00.000Z", counts: { pendingSubscribers: 1, endedSubscribers: 4, unusedLinks: 2, expiredSendLinks: 3 }, finished: true, enabled: true } },
    });
    renderIt();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    expect(within(purge).getByText("Off")).toBeInTheDocument();
    expect(purge).not.toHaveTextContent("Last run");
  });

  it("Distribution unavailable: says so, offers no Distribution button, NoD controls still work", async () => {
    stub(["NoD.Admin"], { ...OPS, distribution: null, bounceSource: null });
    renderIt();
    const dist = await screen.findByRole("region", { name: "Distribution" });
    expect(within(dist).getByText(/Distribution isn’t responding/)).toBeInTheDocument();
    expect(within(dist).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause News On Demand sending" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Test bounce upload" })).toBeNull();
  });

  it("sets the summary address and offers the server default back", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    expect(await screen.findByText("Using the server default: server@example.test")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Bounce summary email" });
    await user.type(field, "staff@example.test");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-summary-address", method: "PUT", body: { address: "staff@example.test" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Bounce summary address saved.");
  });

  it("Ctrl+S (⌘S on a Mac) saves the form focus is in — the screen has two", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    await screen.findByText("Using the server default: server@example.test");
    const field = screen.getByRole("textbox", { name: "Bounce summary email" });
    await userEvent.setup().type(field, "staff@example.test");
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-summary-address", method: "PUT", body: { address: "staff@example.test" } }));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("pressing Enter twice in the Bounce summary email field while saving sends only one request", async () => {
    let resolvePut!: (v: Response) => void;
    const calls = stub(["NoD.Admin"], OPS, { bounceAddress: () => new Promise<Response>((resolve) => (resolvePut = resolve)) });
    renderIt();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Bounce summary email" });
    await user.type(field, "staff@example.test{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-summary-address")).toHaveLength(1));

    await user.type(field, "{Enter}");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-summary-address")).toHaveLength(1);

    resolvePut(jsonResponse(200, { changed: true, bounceSummary: { address: "staff@example.test", from: "setting" } }));
    await screen.findByRole("status");
    expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-summary-address")).toHaveLength(1);
  });

  it("pressing Enter twice in the Soft codes field while saving sends only one request", async () => {
    let resolvePut!: (v: Response) => void;
    const calls = stub(["NoD.Admin"], OPS, { softCodes: () => new Promise<Response>((resolve) => (resolvePut = resolve)) });
    renderIt();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Soft bounces counted as hard" });
    const field = within(region).getByRole("textbox", { name: "Soft codes counted as hard" });
    await user.type(field, "4.4.7{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-soft-codes")).toHaveLength(1));

    await user.type(field, "{Enter}");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-soft-codes")).toHaveLength(1);

    resolvePut(jsonResponse(200, { changed: true, softCodesCounted: ["4.4.7"] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url === "/nod/api/operations/bounce-soft-codes")).toHaveLength(1);
  });

  it("uploads a pasted bounce on a fake-mailbox site", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const upload = await screen.findByRole("region", { name: "Test bounce upload" });
    await user.type(within(upload).getByRole("textbox", { name: "Or paste the message" }), "Subject: Undeliverable");
    await user.click(within(upload).getByRole("button", { name: "Upload bounce" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/bounces/inbox", method: "POST", body: { raw: "Subject: Undeliverable" } }));
  });
  it("on the server default the field starts empty, and saving it empty never stores the default", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    expect(await screen.findByText("Using the server default: server@example.test")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Bounce summary email" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-summary-address", method: "PUT", body: { address: null } }));
    expect(calls.some((c) => c.method === "PUT" && (c.body as { address: unknown }).address === "server@example.test")).toBe(false);
  });

  it("a staff-set address fills the field", async () => {
    stub(["NoD.Admin"], { ...OPS, bounceSummary: { address: "staff@example.test", from: "setting" } });
    renderIt();
    expect(await screen.findByRole("textbox", { name: "Bounce summary email" })).toHaveValue("staff@example.test");
    expect(screen.queryByText(/Using the server default/)).toBeNull();
    expect(screen.getByRole("button", { name: "Use the server default" })).toBeInTheDocument();
  });

  it("a refused upload shows the server's reason", async () => {
    stub(["NoD.Admin"], OPS, { upload: () => jsonResponse(400, { error: "invalid bounce message (too large or malformed)" }) });
    renderIt();
    const user = userEvent.setup();
    const upload = await screen.findByRole("region", { name: "Test bounce upload" });
    await user.type(within(upload).getByRole("textbox", { name: "Or paste the message" }), "not a bounce");
    await user.click(within(upload).getByRole("button", { name: "Upload bounce" }));
    expect(await within(upload).findByRole("alert")).toHaveTextContent("invalid bounce message (too large or malformed)");
  });

  it("a failed load says so", async () => {
    stub(["NoD.Admin"], OPS, { load: () => jsonResponse(500, { error: "internal error" }) });
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load operations.");
    expect(screen.queryByRole("region", { name: "News On Demand sending" })).toBeNull();
  });

  it("saves soft codes that count as hard bounces", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Soft bounces counted as hard" });
    await user.type(within(region).getByRole("textbox", { name: "Soft codes counted as hard" }), "4.4.7, 4.2.2");
    await user.click(within(region).getByRole("button", { name: "Save codes" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-soft-codes", method: "PUT", body: { codes: ["4.4.7", "4.2.2"] } }));
  });

  it("explains a rejected soft code", async () => {
    stub(["NoD.Admin"], OPS, { softCodes: () => jsonResponse(400, { error: "invalid request" }) });
    renderIt();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Soft bounces counted as hard" });
    await user.type(within(region).getByRole("textbox", { name: "Soft codes counted as hard" }), "5.1.1");
    await user.click(within(region).getByRole("button", { name: "Save codes" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Enter codes like 4.2.2, separated by commas.");
  });

  it("the purge: off, what it would delete if it ran now, and the link cleanup that always runs", async () => {
    stub(["NoD.Admin"]);
    renderIt();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    expect(within(purge).getByText("Off")).toBeInTheDocument();
    expect(purge).toHaveTextContent("0 unconfirmed subscribers");
    expect(purge).toHaveTextContent("3 ended subscribers");
    expect(purge).toHaveTextContent("2 unused links");
    expect(purge).toHaveTextContent("(40 waiting)");
  });

  it("turning the purge on asks first, says it can't be undone, then saves and reloads", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    await user.click(within(purge).getByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 subscribers and 2 unused links");
    expect(dialog).toHaveTextContent("can’t be undone");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/purge", method: "PUT", body: { enabled: true } }));
    await waitFor(() => expect(screen.getAllByRole("status").filter((s) => s.textContent === "Retention purge turned on.")).toHaveLength(1));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed switch keeps the dialog open with the error inside it", async () => {
    stub(["NoD.Admin"], OPS, { purge: () => jsonResponse(500, { error: "internal" }) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn’t change it. Nothing changed.");
  });

  it("the purge dialog can't be dismissed by clicking outside it while the save is in flight, so a failure still lands inside it", async () => {
    let settle!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    stub(["NoD.Admin"], OPS, { purge: () => pending });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    await user.click(document.body);
    expect(await screen.findByRole("alertdialog")).toBe(dialog);
    settle(jsonResponse(500, { error: "internal" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn’t change it. Nothing changed.");
  });

  it("Escape doesn't close the purge dialog while the save is in flight", async () => {
    let settle!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    stub(["NoD.Admin"], OPS, { purge: () => pending });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on purge" }));
    // The pressed button is disabled while saving, so focus is put back inside the dialog first.
    dialog.focus();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog")).toBe(dialog);
    settle(jsonResponse(500, { error: "internal" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn’t change it. Nothing changed.");
  });

  it("an on purge offers to turn it off, and shows its last night", async () => {
    stub(["NoD.Admin"], {
      ...OPS,
      purge: {
        ...OPS.purge,
        enabled: true,
        lastRun: { cutoff: "2026-10-07T10:00:00.000Z", counts: { pendingSubscribers: 1, endedSubscribers: 4, unusedLinks: 2, expiredSendLinks: 300 }, finished: true, enabled: true },
      },
    });
    renderIt();
    const purge = await screen.findByRole("region", { name: "Retention purge" });
    expect(within(purge).getByText("On")).toBeInTheDocument();
    expect(purge).toHaveTextContent("finished; deleted 5 subscribers and 302 links");
    expect(within(purge).getByRole("button", { name: "Turn off the retention purge" })).toBeInTheDocument();
  });

  it("the emergency feed: the last check's counts", async () => {
    stub(["NoD.Admin"]);
    renderIt();
    const feed = await screen.findByRole("region", { name: "Emergency alerts feed" });
    expect(feed).toHaveTextContent("https://emergency.example.test/feed.xml");
    expect(feed).toHaveTextContent("2 alerts in the feed, 1 new, 0 updated");
  });

  it("the emergency feed: a failed check is a warning with its label", async () => {
    stub(["NoD.Admin"], { ...OPS, emergencyFeed: { ...OPS.emergencyFeed, result: { ...OPS.emergencyFeed.result!, ok: false, error: "http-503" } } });
    renderIt();
    const feed = await screen.findByRole("region", { name: "Emergency alerts feed" });
    expect(await within(feed).findByText(/failed: http-503\. It tries again every 5 minutes\./)).toBeInTheDocument();
  });

  it("the emergency feed: alerts that couldn't be recorded are a warning of their own, not an unknown-error label", async () => {
    stub(["NoD.Admin"], { ...OPS, emergencyFeed: { ...OPS.emergencyFeed, result: { ...OPS.emergencyFeed.result!, ok: false, error: null, failed: 2 } } });
    renderIt();
    const feed = await screen.findByRole("region", { name: "Emergency alerts feed" });
    expect(await within(feed).findByText("2 alerts couldn’t be recorded. It tries again every 5 minutes.")).toBeInTheDocument();
    expect(within(feed).queryByText(/unknown error/)).toBeNull();
  });

  it("the emergency feed: none configured says so", async () => {
    stub(["NoD.Admin"], { ...OPS, emergencyFeed: { url: null, checkedAt: null, result: null } });
    renderIt();
    expect(await screen.findByText("No feed is configured (EMERGENCY_FEED_URL), so no emergency alerts are read.")).toBeInTheDocument();
  });
});

// Suite review H2: an Operations setting typed but not saved asks before leaving.
describe("OperationsScreen: leaving with unsaved changes", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const at = { path: "/subscribers/operations" };

  it("leaves freely untouched, and asks once the bounce summary email is changed", async () => {
    stub(["NoD.Admin"]);
    let router = renderGuarded(<OperationsScreen />, at);
    await screen.findByRole("textbox", { name: "Bounce summary email" });
    await expectLeaveFree(router);
    cleanup();

    stub(["NoD.Admin"]);
    router = renderGuarded(<OperationsScreen />, at);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Bounce summary email" }), "x");
    await expectLeaveAsks(router, user);
  });
});

