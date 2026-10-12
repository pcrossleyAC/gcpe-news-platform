import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { SessionProvider } from "../session/SessionContext";
import { ENTRA_ERRORS, SignIn } from "./SignIn";

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** /core/auth/session (SessionProvider's own initial load) always answers 401 here — these
 * tests start signed out, same as a real visit to /hub/sign-in. /core/auth/methods answers
 * `methods` (password only, unless a test says otherwise). */
function stubFetch(loginHandler: (init: RequestInit) => Response, methods: Response = jsonResponse(200, { entra: false, local: true })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/core/auth/session") return jsonResponse(401, { error: "not signed in" });
      if (url === "/core/auth/methods") return methods.clone();
      if (url === "/core/auth/login") return loginHandler(init);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}
const noLogin = () => jsonResponse(401, { error: "invalid credentials" });

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

  it("offers Sign in with Microsoft when Entra is on, carrying the return path under /hub", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn("/sign-in?return=%2Freleases%2Fabc");
    const link = await screen.findByRole("link", { name: "Sign in with Microsoft" });
    expect(link).toHaveAttribute("href", "/core/auth/entra?returnTo=%2Fhub%2Freleases%2Fabc");
    expect(screen.getByLabelText(/user name/i)).toBeInTheDocument();
    // The Microsoft control is a link, so the form's own button stays the only "Sign in" button.
    expect(screen.getAllByRole("button", { name: /sign in/i })).toHaveLength(1);
  });

  it("an unsafe return path becomes /hub/ in the Microsoft link", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn("/sign-in?return=%2F%2Fevil.example.test");
    expect(await screen.findByRole("link", { name: "Sign in with Microsoft" })).toHaveAttribute("href", "/core/auth/entra?returnTo=%2Fhub%2F");
  });

  it("shows only the Microsoft link when passwords are off", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: false }));
    renderSignIn();
    await screen.findByRole("link", { name: "Sign in with Microsoft" });
    expect(screen.queryByLabelText(/user name/i)).not.toBeInTheDocument();
  });

  it("shows the password form only when Entra is off or the methods can't be read", async () => {
    stubFetch(noLogin, jsonResponse(500, { error: "boom" }));
    renderSignIn();
    await screen.findByLabelText(/user name/i);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toContain("/core/auth/methods"));
    expect(screen.queryByRole("link", { name: "Sign in with Microsoft" })).not.toBeInTheDocument();
  });

  // A failed /core/auth/methods must not silently hide Microsoft sign-in without saying why —
  // the screen still offers the password form, and says Microsoft sign-in is unavailable.
  it("when /core/auth/methods fails, offers the password form and says Microsoft sign-in is unavailable", async () => {
    stubFetch(noLogin, jsonResponse(500, { error: "boom" }));
    renderSignIn();
    expect(await screen.findByLabelText(/user name/i)).toBeInTheDocument();
    expect(await screen.findByText(/Microsoft sign-in is unavailable right now/)).toBeInTheDocument();
  });

  it.each(["__proto__", "toString", "constructor", "hasOwnProperty", "<script>alert(1)</script>"])(
    "a crafted ?error=%s shows no alert and doesn't crash",
    async (code) => {
      stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
      renderSignIn(`/sign-in?error=${encodeURIComponent(code)}`);
      await screen.findByLabelText(/user name/i);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(code);
    },
  );

  it.each(Object.entries(ENTRA_ERRORS))("shows the message for ?error=%s", async (code, message) => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn(`/sign-in?error=${code}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("uses the agreed wording, and shows nothing for an unknown code", async () => {
    expect(ENTRA_ERRORS).toEqual({
      cancelled: "Sign-in was cancelled.",
      expired: "Your sign-in took too long. Please try again.",
      failed: "We couldn't sign you in with Microsoft. Please try again.",
      not_provisioned: "Your account hasn't been set up. Contact an administrator.",
      inactive: "Your account hasn't been set up. Contact an administrator.",
      conflict: "Your account needs an administrator to check it. Contact an administrator.",
    });
    stubFetch(noLogin);
    renderSignIn("/sign-in?error=<script>");
    await screen.findByLabelText(/user name/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
