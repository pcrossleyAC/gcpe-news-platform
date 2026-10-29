import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { jsonResponse } from "../../../../test/jsonResponse";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { HandOverPanel } from "./HandOverPanel";

/** Unavailable to the user: natively disabled, or a BC button that is busy (aria-disabled, still focusable). */
function expectUnavailable(el: HTMLElement): void {
  expect(el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true").toBe(true);
}

const base = {
  isHq: false,
  isPublic: true,
  sortOrder: 1,
  parentKey: null,
  minister: { name: null },
  url: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  successorKeys: [],
};
const org = (key: string, displayName: string, abbreviation: string | null, isActive = true) =>
  ({ ...base, key, displayName, abbreviation, isActive }) as unknown as OrgRecord;

const HEALTH = org("health", "Health", "HLTH");
const JOBS = org("jobs", "Jobs", null);
const FINANCE = org("finance", "Finance", "FIN");
const OLD = org("old", "Old Ministry", "OLD", false);
const ORGS = [HEALTH, JOBS, FINANCE, OLD];

const COUNT_URLS = {
  core: "/core/api/organizations/health/succession-preview",
  // exact=true: only A's own subscribers, not "all news" ones who never move (review F1).
  nod: "/nod/api/subscribers/count?lists=ministries:health&exact=true",
  calendar: "/calendar/api/succession/health/preview",
  nrms: "/nrms/api/ministries/health/open-releases",
};

type Call = { url: string; init?: RequestInit };
let overrides: Record<string, () => Response> = {};

function stub(calls: Call[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const o = overrides[`${init?.method ?? "GET"} ${url}`];
      if (o) return o();
      switch (url) {
        case COUNT_URLS.core:
          return jsonResponse(200, { staff: 3, abbreviation: "HLTH" });
        case COUNT_URLS.nod:
          return jsonResponse(200, { count: 120 });
        case COUNT_URLS.calendar:
          return jsonResponse(200, { activities: 4, contacts: 2 });
        case COUNT_URLS.nrms:
          return jsonResponse(200, {
            drafts: [
              { id: "r1", headline: "Draft one" },
              { id: "r3", headline: "Draft two" },
            ],
            notMoved: [{ id: "r2", headline: "Approved one", status: "approved", key: "2026HLTH0001" }],
          });
        case "/core/api/organizations/health/succeed":
        case "/core/api/organizations/old/succeed":
          return jsonResponse(200, { ...HEALTH, isActive: false });
        case "/core/api/organizations/health/deactivate":
          return new Response(null, { status: 204 });
        default:
          throw new Error(`unhandled: ${url}`);
      }
    }),
  );
}

const postBody = (calls: Call[], suffix: string) => {
  const call = calls.find((c) => c.url.endsWith(suffix) && c.init?.method === "POST");
  return call ? (JSON.parse(call.init!.body as string) as unknown) : undefined;
};

function renderPanel(a: OrgRecord = HEALTH, orgs: OrgRecord[] = ORGS) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const onBusyChange = vi.fn();
  const view = render(
    <AnnouncerProvider>
      <MemoryRouter>
        <HandOverPanel org={a} orgs={orgs} onDone={onDone} onCancel={onCancel} onBusyChange={onBusyChange} />
      </MemoryRouter>
    </AnnouncerProvider>,
  );
  return { ...view, onDone, onCancel, onBusyChange };
}

const chooseSuccessor = async (name: string, label: RegExp | string = "Has a successor?") =>
  userEvent.setup().selectOptions(screen.getByLabelText(label), name);

describe("HandOverPanel", () => {
  afterEach(() => {
    cleanup();
    overrides = {};
    vi.unstubAllGlobals();
  });

  it("shows counts from four services and posts the ticked moves", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    expect(screen.getByRole("heading", { name: "Deactivate Health" })).toHaveFocus();
    await chooseSuccessor("Jobs");

    expect(screen.getByRole("checkbox", { name: "Send Health's web pages to Jobs" })).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Move 120 subscribers to Jobs." })).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Move 3 staff from Health to Jobs." })).toBeChecked();
    expect(
      await screen.findByRole("checkbox", { name: "Move 4 upcoming Calendar activities and 2 comm contacts to Jobs." }),
    ).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Move 2 draft releases to Jobs." })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Let Jobs use the abbreviation HLTH." })).toBeChecked();
    // Approved and scheduled releases stay with A, each linked (N10).
    expect(screen.getByRole("link", { name: /Approved one/ })).toHaveAttribute("href", "/releases/r2");
    expect(Object.values(COUNT_URLS).every((u) => calls.some((c) => c.url === u))).toBe(true);

    await userEvent.setup().click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Jobs"));
    expect(postBody(calls, "/health/succeed")).toEqual({
      successorKeys: ["jobs"],
      moveSubscribers: true,
      moveStaff: true,
      moveCalendar: true,
      moveDrafts: true,
      takeAbbreviation: true,
    });
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
  });

  it("an unticked move is sent as false", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    await user.click(await screen.findByRole("checkbox", { name: "Move 3 staff from Health to Jobs." }));
    await user.click(await screen.findByRole("checkbox", { name: /upcoming Calendar activities/ }));
    await user.click(screen.getByRole("checkbox", { name: "Let Jobs use the abbreviation HLTH." }));
    await user.click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(postBody(calls, "/health/succeed")).toEqual({
      successorKeys: ["jobs"],
      moveSubscribers: true,
      moveStaff: false,
      moveCalendar: false,
      moveDrafts: true,
      takeAbbreviation: false,
    });
  });

  it('a failed count shows "count unavailable" and still allows submit', async () => {
    overrides[`GET ${COUNT_URLS.nod}`] = () => jsonResponse(500, { error: "internal error" });
    overrides[`GET ${COUNT_URLS.calendar}`] = () => {
      throw new TypeError("network down");
    };
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    await chooseSuccessor("Jobs");
    const subscribers = await screen.findByRole("checkbox", { name: /subscribers to Jobs.*count unavailable/ });
    expect(subscribers).toBeChecked();
    expect(subscribers).not.toHaveAccessibleName(/\b0\b/);
    expect(await screen.findByRole("checkbox", { name: /Calendar activities.*count unavailable/ })).toBeChecked();
    // The services that answered still show their numbers.
    expect(await screen.findByRole("checkbox", { name: "Move 3 staff from Health to Jobs." })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Jobs"));
    expect(postBody(calls, "/health/succeed")).toMatchObject({ moveSubscribers: true, moveCalendar: true });
  });

  it("the abbreviation line appears only when B has none or the admin opts to replace it", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    expect(screen.getByRole("checkbox", { name: "Let Jobs use the abbreviation HLTH." })).toBeInTheDocument();

    await chooseSuccessor("Finance");
    expect(screen.queryByRole("checkbox", { name: /use the abbreviation/ })).toBeNull();
    const replace = screen.getByRole("checkbox", { name: "Replace Finance's abbreviation FIN with HLTH" });
    expect(replace).not.toBeChecked();
    await user.click(replace);
    expect(screen.getByRole("checkbox", { name: "Let Finance use the abbreviation HLTH." })).toBeChecked();
    await user.click(replace);
    expect(screen.queryByRole("checkbox", { name: /use the abbreviation/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Finance"));
    expect(postBody(calls, "/health/succeed")).toMatchObject({ successorKeys: ["finance"], takeAbbreviation: false });
  });

  it("has no abbreviation line when A has no abbreviation", async () => {
    stub([]);
    renderPanel(org("health", "Health", null), [org("health", "Health", null), JOBS]);
    await chooseSuccessor("Jobs");
    await screen.findByRole("checkbox", { name: "Move 120 subscribers to Jobs." });
    expect(screen.queryByRole("checkbox", { name: /abbreviation/ })).toBeNull();
  });

  it("without a successor it is today's deactivate", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    expect(
      screen.getByText(
        "Deactivate Health? It disappears from the public site, and its subscribers stop receiving news. This can be undone with Reactivate, but subscribers are not moved to another ministry.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate and hand over" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(calls.some((c) => c.url === "/core/api/organizations/health/deactivate" && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/succeed"))).toBe(false);
  });

  it("422 copy is shown inline", async () => {
    overrides["POST /core/api/organizations/health/succeed"] = () =>
      jsonResponse(422, { error: "Jobs already leads back to Health; that would loop." });
    stub([]);
    const { onDone } = renderPanel();
    await chooseSuccessor("Jobs");
    const submit = screen.getByRole("button", { name: "Deactivate and hand over" });
    await userEvent.setup().click(submit);
    const form = screen.getByRole("form", { name: "Deactivate Health" });
    expect(await within(form).findByRole("alert")).toHaveTextContent("Jobs already leads back to Health; that would loop.");
    expect(submit).toHaveFocus();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a 409 on the abbreviation says which ministry holds it", async () => {
    overrides["POST /core/api/organizations/health/succeed"] = () =>
      jsonResponse(409, { error: "abbreviation-taken", takenBy: "Finance" });
    stub([]);
    renderPanel();
    await chooseSuccessor("Jobs");
    await userEvent.setup().click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Finance already uses the abbreviation HLTH. Untick "Let Jobs use the abbreviation HLTH." or change Finance\'s abbreviation first.',
    );
  });

  it("a second successor gets the subscribers too, and is sent in order", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel();
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    await user.click(screen.getByRole("button", { name: "Add another successor" }));
    await user.selectOptions(screen.getByLabelText("Successor 2"), "Finance");
    expect(await screen.findByRole("checkbox", { name: "Move 120 subscribers to Jobs, Finance." })).toBeInTheDocument();
    // Staff and the rest go to the first successor only.
    expect(await screen.findByRole("checkbox", { name: "Move 3 staff from Health to Jobs." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deactivate and hand over" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Jobs"));
    expect(postBody(calls, "/health/succeed")).toMatchObject({ successorKeys: ["jobs", "finance"] });
  });

  it("the successor list leaves out A and inactive ministries", async () => {
    stub([]);
    renderPanel();
    const options = within(screen.getByLabelText("Has a successor?"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["No successor", "Jobs", "Finance"]);
  });

  it("Set successor on an inactive ministry needs a choice and never deactivates", async () => {
    overrides["GET /core/api/organizations/old/succession-preview"] = () => jsonResponse(200, { staff: 0, abbreviation: "OLD" });
    overrides["GET /nod/api/subscribers/count?lists=ministries:old&exact=true"] = () => jsonResponse(200, { count: 0 });
    overrides["GET /calendar/api/succession/old/preview"] = () => jsonResponse(200, { activities: 0, contacts: 0 });
    overrides["GET /nrms/api/ministries/old/open-releases"] = () => jsonResponse(200, { drafts: [], notMoved: [] });
    const calls: Call[] = [];
    stub(calls);
    const { onDone } = renderPanel(OLD);
    const user = userEvent.setup();
    expect(screen.getByRole("heading", { name: "Set successor for Old Ministry" })).toHaveFocus();
    expect(screen.queryByText(/Deactivate Old Ministry\?/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Set successor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose an active ministry as successor.");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
    await chooseSuccessor("Jobs", "Successor");
    await user.click(screen.getByRole("button", { name: "Set successor" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("Jobs"));
    expect(postBody(calls, "/old/succeed")).toMatchObject({ successorKeys: ["jobs"] });
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
  });

  it("Cancel calls onCancel and posts nothing", async () => {
    const calls: Call[] = [];
    stub(calls);
    const { onCancel } = renderPanel();
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  it("has no serious accessibility violations with a successor chosen and a failed count", async () => {
    overrides[`GET ${COUNT_URLS.nod}`] = () => jsonResponse(500, { error: "internal error" });
    stub([]);
    const { container } = renderPanel();
    await chooseSuccessor("Finance");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /Replace Finance's abbreviation/ }));
    await screen.findByRole("checkbox", { name: /count unavailable/ });
    await screen.findByRole("link", { name: /Approved one/ });
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
  it("Add another successor focuses the new picker; Remove focuses the one before it", async () => {
    stub([]);
    renderPanel();
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    await user.click(screen.getByRole("button", { name: "Add another successor" }));
    expect(screen.getByLabelText("Successor 2")).toHaveFocus();
    await user.selectOptions(screen.getByLabelText("Successor 2"), "Finance");
    await user.click(screen.getByRole("button", { name: "Remove successor 2" }));
    expect(screen.queryByLabelText("Successor 2")).toBeNull();
    expect(screen.getByLabelText("Has a successor?")).toHaveFocus();
  });

  it("a double click sends one request, and the button says it is busy meanwhile", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    overrides["POST /core/api/organizations/health/succeed"] = () => {
      throw new Error("replaced below");
    };
    const calls: Call[] = [];
    stub(calls);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = fetchMock.getMockImplementation()! as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health/succeed")) {
        calls.push({ url, init });
        await pending;
        return jsonResponse(200, { ...HEALTH, isActive: false });
      }
      return inner(url, init);
    });
    const { onDone, onBusyChange } = renderPanel();
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    const submit = screen.getByRole("button", { name: "Deactivate and hand over" });
    await user.dblClick(submit);
    await user.click(submit);
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expectUnavailable(screen.getByRole("button", { name: "Cancel" }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    release();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url.endsWith("/health/succeed"))).toHaveLength(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("changing the first successor clears the other pickers and says so", async () => {
    stub([]);
    renderPanel(HEALTH, [...ORGS, org("tourism", "Tourism", null)]);
    const user = userEvent.setup();
    await chooseSuccessor("Jobs");
    await user.click(screen.getByRole("button", { name: "Add another successor" }));
    await user.selectOptions(screen.getByLabelText("Successor 2"), "Finance");
    await chooseSuccessor("Tourism");
    expect(screen.queryByLabelText("Successor 2")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("The other successors were cleared. Add them again if you need them.");
    expect(await screen.findByRole("checkbox", { name: "Move 120 subscribers to Tourism." })).toBeInTheDocument();
  });
});
