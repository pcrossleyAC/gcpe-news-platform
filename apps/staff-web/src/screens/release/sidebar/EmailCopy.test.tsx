import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { EmailCopy } from "./EmailCopy";

const VIEW = releaseView();

/** Stubs fetch: the session (as `email`) plus `emailCopy` for the send itself; records every
 * non-session URL in `calls`. */
function stub(email: string, emailCopy: () => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email, roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
      calls.push(url);
      return emailCopy();
    }),
  );
  return calls;
}

function renderEmailCopy() {
  render(
    <SessionProvider>
      <EmailCopy view={VIEW} />
    </SessionProvider>,
  );
}

describe("EmailCopy", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows 'Sent to <email>' on success", async () => {
    const calls = stub("pat@example.invalid", () => jsonResponse(202, { sentTo: "pat@example.invalid" }));
    renderEmailCopy();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Email me a copy" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText("Sent to pat@example.invalid")).toBeInTheDocument();
    expect(calls).toEqual([`/nrms/api/releases/${VIEW.id}/email-copy`]);
  });

  it("shows the server's 422 message", async () => {
    stub("pat@example.invalid", () => jsonResponse(422, { error: "Your account has no email address to send to." }));
    renderEmailCopy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Email me a copy" }));
    expect(await screen.findByText("Your account has no email address to send to.")).toBeInTheDocument();
  });

  it("shows the server's 503 message", async () => {
    stub("pat@example.invalid", () => jsonResponse(503, { error: "Email isn't configured." }));
    renderEmailCopy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Email me a copy" }));
    expect(await screen.findByText("Email isn't configured.")).toBeInTheDocument();
  });

  it("an account with no email address (the break-glass admin) gets a disabled button and says why, without calling the server", async () => {
    const calls = stub("", () => jsonResponse(202, { sentTo: "" }));
    renderEmailCopy();
    const note = await screen.findByText(/signed in as the break-glass administrator/);
    const button = screen.getByRole("button", { name: "Email me a copy" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", note.id);
    expect(calls).toEqual([]);
  });
});
