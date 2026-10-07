import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { SignIn } from "./SignIn";

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** /core/auth/session (SessionProvider's own initial load) always answers 401 here — these
 * tests start signed out, same as a real visit to /hub/sign-in. */
function stubFetch(loginHandler: (init: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/core/auth/session") return jsonResponse(401, { error: "not signed in" });
      if (url === "/core/auth/login") return loginHandler(init);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderSignIn(initialPath = "/sign-in") {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="*" element={<div>landed: welcome</div>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SignIn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  // I5: document.title matches the h1.
  it("sets the document title", async () => {
    stubFetch(() => jsonResponse(401, { error: "not signed in" }));
    renderSignIn();
    await screen.findByRole("heading", { name: "Sign in", level: 1 });
    await waitFor(() => expect(document.title).toBe("Sign in — GCPE News Staff"));
  });

  it("submitting calls POST /core/auth/login with the entered credentials", async () => {
    const calls: RequestInit[] = [];
    stubFetch((init) => {
      calls.push(init);
      return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@example.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
    });
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/user name/i), "pat");
    await user.type(screen.getByLabelText(/password/i), "s3cret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ username: "pat", password: "s3cret" });
    expect(new Headers(calls[0]!.headers).get("X-GCPE-Request")).toBe("1");
  });

  it("401 shows the generic sign-in-failed message", async () => {
    stubFetch(() => jsonResponse(401, { error: "invalid credentials" }));
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/user name/i), "pat");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Sign-in failed. Check your user name and password.")).toBeInTheDocument();
  });

  it("429 shows the rate-limit message", async () => {
    stubFetch(() => textResponse(429, "Too many requests, please try again later."));
    renderSignIn();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/user name/i), "pat");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Too many attempts, wait a minute")).toBeInTheDocument();
  });

  it("success navigates to the return path", async () => {
    stubFetch(() => jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@example.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() }));
    renderSignIn("/sign-in?return=%2Freleases%2Fabc");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/user name/i), "pat");
    await user.type(screen.getByLabelText(/password/i), "s3cret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("landed: welcome")).toBeInTheDocument();
  });
});
