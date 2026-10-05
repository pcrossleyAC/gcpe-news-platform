import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { NewReleaseScreen } from "./NewReleaseScreen";

const IMG_ID = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(onPost?: (body: unknown) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url === "/nrms/api/page-types") {
        return jsonResponse(200, [
          { pageTitle: "News Release", languageId: 4105, releaseType: "release", sortOrder: 0, layout: "formal", pageImageId: IMG_ID },
          { pageTitle: "Backgrounder", languageId: 4105, releaseType: "release", sortOrder: 1, layout: "informal", pageImageId: null },
          { pageTitle: "Media Advisory", languageId: 4105, releaseType: "advisory", sortOrder: 0, layout: "formal", pageImageId: null },
        ]);
      }
      if (url === "/nrms/api/page-images") return jsonResponse(200, [{ id: IMG_ID, name: "Legislature", sortOrder: 0, mimeType: "image/png", altTexts: {} }]);
      if (url === "/nrms/api/categories") {
        return jsonResponse(200, {
          ministries: [
            { key: "health", name: "Health" },
            { key: "education", name: "Education" },
          ],
          sectors: [{ key: "sector1", name: "Sector One" }],
          themes: [{ key: "theme1", name: "Theme One" }],
          tags: [],
        });
      }
      if (url === "/nrms/api/media-lists") return jsonResponse(200, [{ id: "m1", key: "list1", name: "List One" }]);
      if (url === "/nrms/api/releases" && init?.method === "POST") {
        return onPost ? onPost(body) : jsonResponse(201, releaseView());
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/releases/new"]}>
      <Routes>
        <Route path="/releases/new" element={<NewReleaseScreen />} />
        <Route path="/releases/:id" element={<p>Editor page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewReleaseScreen (acceptance: each type shows exactly its required fields; 422 maps to fields)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("offers only the creatable types", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature", {}, { timeout: 2000 }).catch(() => {});
    const select = screen.getByLabelText("Type") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Release", "Story", "Factsheet", "Advisory"]);
  });

  it("Release shows page image and sectors/themes/tags; Advisory hides them but requires a media list", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    expect(screen.getByText("Page image")).toBeInTheDocument();
    expect(screen.getByText("Sectors")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type"), "advisory");

    expect(screen.queryByText("Page image")).not.toBeInTheDocument();
    expect(screen.queryByText("Sectors")).not.toBeInTheDocument();
    expect(screen.getByText("Media distribution lists (required)")).toBeInTheDocument();
  });

  it("Story hides media distribution lists entirely", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type"), "story");
    expect(screen.queryByText(/media distribution list/i)).not.toBeInTheDocument();
  });

  it("choosing a page title fills in its default layout and page image", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    expect((screen.getByLabelText("Layout") as HTMLSelectElement).value).toBe("formal");
    expect(screen.getByRole("radio", { name: /Legislature/ })).toBeChecked();

    await user.selectOptions(screen.getByLabelText("Page title"), "Backgrounder");
    expect((screen.getByLabelText("Layout") as HTMLSelectElement).value).toBe("informal");
    expect(screen.getByRole("radio", { name: "(none)" })).toBeChecked();
  });

  it("client-side validation blocks submission with no headline (createReleaseSchema)", async () => {
    const calls = stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.click(screen.getByRole("button", { name: "Create release" }));

    await waitFor(() => expect(screen.getByLabelText("Headline", { exact: false })).toHaveAttribute("aria-invalid", "true"));
    expect(calls.some((c) => c.url === "/nrms/api/releases")).toBe(false);
  });

  it("on success, POSTs the release and navigates to its editor", async () => {
    const created = releaseView({ id: "99999999-9999-9999-9999-999999999999" });
    stubFetch(() => jsonResponse(201, created));
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "Clinics open this weekend");
    await user.click(screen.getByLabelText("Health"));
    await user.click(screen.getByRole("button", { name: "Create release" }));

    await waitFor(() => expect(screen.getByText("Editor page")).toBeInTheDocument());
  });

  it("a server 422 maps its problems onto the ministries field", async () => {
    stubFetch(() => jsonResponse(422, { error: "bad", problems: ["Choose at least one ministry."] }));
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "A headline");
    await user.click(screen.getByRole("button", { name: "Create release" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /choose at least one ministry/i.test(a.textContent ?? ""))).toBe(true);
  });
});
