import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { EmailCopy } from "./EmailCopy";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const VIEW = releaseView();

describe("EmailCopy", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows 'Sent to <email>' on success", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(202, { sentTo: "pat@example.invalid" });
      }),
    );
    render(<EmailCopy view={VIEW} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Email me a copy" }));
    expect(await screen.findByText("Sent to pat@example.invalid")).toBeInTheDocument();
    expect(calls).toEqual([`/nrms/api/releases/${VIEW.id}/email-copy`]);
  });

  it("shows the server's 422 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { error: "Your account has no email address to send to." })));
    render(<EmailCopy view={VIEW} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Email me a copy" }));
    expect(await screen.findByText("Your account has no email address to send to.")).toBeInTheDocument();
  });

  it("shows the server's 503 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { error: "Email isn't configured." })));
    render(<EmailCopy view={VIEW} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Email me a copy" }));
    expect(await screen.findByText("Email isn't configured.")).toBeInTheDocument();
  });
});
