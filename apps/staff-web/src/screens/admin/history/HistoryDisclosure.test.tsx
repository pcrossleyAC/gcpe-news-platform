import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HistoryDisclosure } from "./HistoryDisclosure";
import { AnnouncerProvider } from "../../../shared/Announcer";

const entry = (id: number) => ({ id, at: "2026-01-15T17:00:00Z", actorId: "a", actorName: `Admin ${id}`, action: "user.password-set", targetType: "user", targetId: "jo", targetLabel: "Jo", details: {} });

describe("HistoryDisclosure", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Show older changes loads the next 20, keeping the first, until there are no more", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith("/core/api/audit?")) {
          const page = Number(new URL(url, "http://x").searchParams.get("page"));
          const ids = page === 1 ? Array.from({ length: 20 }, (_, i) => 25 - i) : [5, 4, 3, 2, 1];
          return jsonResponse(200, { items: ids.map(entry), total: 25, page, pageSize: 20 });
        }
        return jsonResponse(200, { timeZone: "America/Vancouver" });
      }),
    );
    const user = userEvent.setup();
    render(
      <AnnouncerProvider>
        <HistoryDisclosure targetType="user" targetId="jo" name="Jo" />
      </AnnouncerProvider>,
    );
    await user.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Changes to Jo, newest first" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    await user.click(screen.getByRole("button", { name: "Show older changes" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Changes to Jo, newest first" })).getAllByRole("listitem")).toHaveLength(25));
    expect(screen.getByRole("list", { name: "Changes to Jo, newest first" }).lastElementChild).toHaveTextContent("Admin 1 set a new password for Jo");
    expect(screen.queryByRole("button", { name: "Show older changes" })).toBeNull();
    // The button has gone, so focus moves to the first older change rather than the page.
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Changes to Jo, newest first" })).getAllByRole("listitem")[20]).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("5 older changes shown");
    expect(calls.filter((c) => c.startsWith("/core/api/audit")).map((c) => new URL(c, "http://x").searchParams.get("page"))).toEqual(["1", "1", "2"]);
  });
});
