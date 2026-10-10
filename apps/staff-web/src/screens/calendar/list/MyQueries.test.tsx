import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { listCalls, qOf, renderList, row, stubFetch, type Call } from "./fixtures";

const SAVED = [
  { id: 7, name: "Sample one", sortOrder: 1, filter: { ...EMPTY_LIST_FILTER, categoryId: 32 } },
  { id: 8, name: "Sample two", sortOrder: 2, filter: null },
];

describe("My Queries and the watchlist (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves the current filter, runs a query, renames, moves and deletes, and can't run one it can't read", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      saved: SAVED,
      other: (url, init) => {
        if (url === "/calendar/api/saved-filters" && init?.method === "POST") return jsonResponse(201, { id: 9, name: "Sample new", sortOrder: 3, filter: EMPTY_LIST_FILTER });
        if (url === "/calendar/api/saved-filters/7" && init?.method === "PUT") return jsonResponse(200, { ...SAVED[0], name: "Sample renamed" });
        if (url === "/calendar/api/saved-filters/order") return jsonResponse(200, [SAVED[1], { ...SAVED[0], name: "Sample renamed" }]);
        if (url === "/calendar/api/saved-filters/8" && init?.method === "DELETE") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    renderList();
    const region = await screen.findByRole("region", { name: "My Queries" });
    const user = userEvent.setup();
    await user.click(await within(region).findByRole("button", { name: "Sample one" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ filter: { categoryId: 32 }, corporate: null }));
    expect(within(region).getByRole("button", { name: "Sample two" })).toBeDisabled();
    expect(within(region).getByText("This query can no longer be read. Delete it.")).toBeInTheDocument();

    await user.type(within(region).getByLabelText("Name for this filter"), "Sample new");
    await user.click(within(region).getByRole("button", { name: "Save query" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Saved the query “Sample new”.");
    const post = calls.find((c) => c.url === "/calendar/api/saved-filters" && c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ name: "Sample new", filter: { categoryId: 32 } });

    await user.click(within(region).getByRole("button", { name: "Rename Sample one" }));
    const rename = within(region).getByRole("form", { name: "Rename Sample one" });
    await user.clear(within(rename).getByLabelText("New name"));
    await user.type(within(rename).getByLabelText("New name"), "Sample renamed");
    await user.click(within(rename).getByRole("button", { name: "Save name" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Renamed to “Sample renamed”.");

    await user.click(within(region).getByRole("button", { name: "Move Sample two up" }));
    expect(JSON.parse(String(calls.find((c) => c.url === "/calendar/api/saved-filters/order")!.init!.body))).toEqual({ ids: [8, 7, 9] });

    await user.click(await within(region).findByRole("button", { name: "Delete Sample two" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Deleted the query “Sample two”.");
  });

  it("a stale order reloads the queries and says why", async () => {
    stubFetch([], {
      saved: [SAVED[0]!, { ...SAVED[0]!, id: 10, name: "Sample ten" }],
      other: (url) => (url === "/calendar/api/saved-filters/order" ? jsonResponse(409, { code: "stale", error: "Your queries changed since you loaded them: reload and try again" }) : undefined),
    });
    renderList();
    const region = await screen.findByRole("region", { name: "My Queries" });
    await userEvent.setup().click(await within(region).findByRole("button", { name: "Move Sample ten up" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Your queries changed in another tab, so they were reloaded.");
  });

  it("the star is a toggle button that names its watchers, and watching updates it", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      page: () => ({ rows: [row({ watcherNames: ["Sample Admin"] })], total: 1, offset: 0 }),
      other: (url, init) => (url === "/calendar/api/activities/20001/watch" ? (init?.method === "PUT" ? new Response(null, { status: 204 }) : undefined) : undefined),
    });
    renderList();
    const star = await screen.findByRole("button", { name: "Watch HLTH-20001" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).toHaveAccessibleDescription("Watched by Sample Admin");
    await userEvent.setup().click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    expect(star).toHaveAccessibleDescription("Watched by Robin Staff, Sample Admin");
    expect(calls.some((c) => c.url === "/calendar/api/activities/20001/watch" && c.init?.method === "PUT")).toBe(true);
  });
});
