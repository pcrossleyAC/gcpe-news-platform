import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { OperationsScreen } from "./OperationsScreen";
import type { OperationsStatus } from "./types";

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
};

type Call = { url: string; method: string; body: unknown };
function stub(
  roles: string[],
  ops: OperationsStatus = OPS,
  opts: { load?: () => Response; upload?: () => Response; softCodes?: () => Response; purge?: () => Response | Promise<Response> } = {},
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
    if (url === "/nod/api/operations/bounce-summary-address") return jsonResponse(200, { changed: true, bounceSummary: { address: "staff@example.test", from: "setting" } });
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
    await user.click(within(dialog).getByRole("button", { name: "Confirm pause" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/settings/pause", method: "POST", body: undefined }));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
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
