import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityChangeView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { renderActivity, stubActivity, view } from "./fixtures";

const CHANGES: ActivityChangeView[] = [
  { id: 3, at: "2026-11-03T18:00:00.000Z", actorName: "Robin Staff", action: "updated", source: "calendar", fields: [{ key: "title", label: "Title", old: "Sample old", new: "Sample new" }, { key: "venue", label: "Venue", old: null, new: "Sample hall" }] },
  { id: 1, at: "2019-05-01T17:00:00.000Z", actorName: "Sample Former Staff", action: "updated", source: "legacy_log", fields: [{ key: "start", label: "Start", old: "2019-05-02 09:00", new: "2019-05-03 09:00" }] },
];
const answer = (changes: ActivityChangeView[] | Response) => (url: string) => (url === "/calendar/api/activities/20001/changes" ? (changes instanceof Response ? changes : jsonResponse(200, changes)) : undefined);

describe("View changes (spec addendum §8.3; C133)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each change newest first: when, who, what, and each field's old and new value; legacy entries marked", async () => {
    stubActivity([], { other: answer(CHANGES) });
    renderActivity("/calendar/activities/20001/changes?return=%2Fcalendar");
    expect(await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" })).toBeInTheDocument();
    const entries = [...document.querySelectorAll<HTMLElement>(".gcpe-changes > li")];
    expect(within(entries[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Nov 3, 2026 11:00 AM: Robin Staff changed it");
    expect(within(entries[0]!).getByRole("row", { name: "Title Sample old Sample new" })).toBeInTheDocument();
    expect(within(entries[0]!).getByRole("row", { name: "Venue — Sample hall" })).toBeInTheDocument();
    expect(entries[1]).toHaveTextContent("from legacy log");
    expect(screen.getByRole("link", { name: "Back to the activity" })).toHaveAttribute("href", "/calendar/activities/20001?return=%2Fcalendar");
  });

  it("an entry naming the same field twice (a legacy log can) shows both rows", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const twice: ActivityChangeView = { id: 7, at: "2019-05-01T17:00:00.000Z", actorName: "Sample Former Staff", action: "updated", source: "legacy_log", fields: [{ key: "start", label: "Start", old: "a", new: "b" }, { key: "start", label: "Start", old: "b", new: "c" }] };
    stubActivity([], { other: answer([twice]) });
    renderActivity("/calendar/activities/20001/changes");
    await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" });
    expect(screen.getAllByRole("row", { name: /^Start / })).toHaveLength(2);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    errors.mockRestore();
  });

  it("says when nothing is recorded yet", async () => {
    stubActivity([], { other: answer([]) });
    renderActivity("/calendar/activities/20001/changes");
    expect(await screen.findByText("No changes are recorded yet.")).toBeInTheDocument();
  });

  it("an activity the user can't see is 'not found'", async () => {
    stubActivity([], { view: () => jsonResponse(404, { error: "not found" }), other: answer(jsonResponse(404, { error: "not found" })) });
    renderActivity("/calendar/activities/20001/changes");
    expect(await screen.findByRole("heading", { level: 1, name: "Activity not found" })).toBeInTheDocument();
  });

  it("a load failure says so", async () => {
    stubActivity([], { other: answer(jsonResponse(500, { error: "boom" })) });
    renderActivity("/calendar/activities/20001/changes");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the changes.");
  });

  it("opens from the editor", async () => {
    stubActivity([], { view: view(), other: answer(CHANGES) });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("link", { name: "View changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" })).toBeInTheDocument();
  });
});
