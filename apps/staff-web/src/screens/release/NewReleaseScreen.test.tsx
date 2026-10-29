import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { SessionProvider } from "../../session/SessionContext";
import { NewReleaseScreen } from "./NewReleaseScreen";

const IMG_ID = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface StubOptions {
  roles?: string[];
  onPost?: (body: unknown) => Response;
  lookups?: Record<string, unknown>;
}

function stubFetch({ roles = ["NRMS.Editor"], onPost, lookups = {} }: StubOptions = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      }
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      const lookup = /^\/nrms\/api\/calendar-activities\/(\d+)$/.exec(url);
      if (lookup) return lookups[lookup[1]!] ? jsonResponse(200, lookups[lookup[1]!]) : jsonResponse(404, { error: "not found" });
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
      if (url === "/nrms/api/media-lists") {
        return jsonResponse(200, [
          { key: "list1", displayName: "List One", sortOrder: 1, isActive: true },
          { key: "old-desk", displayName: "Old desk", sortOrder: 2, isActive: false },
        ]);
      }
      if (url === "/nrms/api/releases" && init?.method === "POST") {
        return onPost ? onPost(body) : jsonResponse(201, releaseView());
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderScreen(path = "/releases/new") {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/releases/new" element={<NewReleaseScreen />} />
          <Route path="/releases/drafts" element={<p>Drafts list</p>} />
          <Route path="/releases/:id" element={<p>Editor page</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
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

  it("offers only active media lists, never a retired one", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    expect(await screen.findByLabelText("List One")).toBeInTheDocument();
    expect(screen.queryByText(/Old desk/)).not.toBeInTheDocument();
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
    stubFetch({ onPost: () => jsonResponse(201, created) });
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
    stubFetch({ onPost: () => jsonResponse(422, { error: "bad", problems: ["Choose at least one ministry."] }) });
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "A headline");
    await user.click(screen.getByRole("button", { name: "Create release" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /choose at least one ministry/i.test(a.textContent ?? ""))).toBe(true);
  });

  it("says what to fix in plain words, in a summary that links each problem to its field", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create release" }));
    const summary = await screen.findByRole("alert", { name: "Fix these to create" });
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole("link", { name: "Choose a page title." })).toHaveAttribute("href", "#new-release-page-title");
    expect(within(summary).getByRole("link", { name: "Enter a headline." })).toHaveAttribute("href", "#new-release-headline");
    expect(summary).not.toHaveTextContent(/String must contain/);
    expect(screen.getByLabelText("Headline", { exact: false })).toHaveAttribute("id", "new-release-headline");
  });

  it("the page title's error sits under Page title itself, and describes that field", async () => {
    stubFetch();
    renderScreen();
    await screen.findByText("Legislature");
    await userEvent.setup().click(screen.getByRole("button", { name: "Create release" }));
    await screen.findByRole("alert", { name: "Fix these to create" });
    const select = screen.getByRole("combobox", { name: "Page title" });
    const error = screen.getAllByText("Choose a page title.").find((e) => e.classList.contains("gcpe-field-error"))!;
    expect(select.closest(".gcpe-field")).toContainElement(error);
    expect(screen.getByRole("combobox", { name: "Type" }).closest(".gcpe-field")).not.toContainElement(error);
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription("Choose a page title.");
  });

  // Fix round 1, finding 1: only NRMS.Editor sees the form at all.
  it("a Viewer gets a permission message instead of the form, with a link back", async () => {
    stubFetch({ roles: ["NRMS.Viewer"] });
    renderScreen();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/don.t have permission/i);
    expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
    // I5: document.title matches the h1, not the "New release" the Editor-only form shows.
    await waitFor(() => expect(document.title).toBe("You don’t have permission to create releases — GCPE News Staff"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("link"));
    expect(await screen.findByText("Drafts list")).toBeInTheDocument();
  });

  it("a Site Editor (no NRMS.Editor) also gets the permission message, not the form", async () => {
    stubFetch({ roles: ["NRMS.SiteEditor"] });
    renderScreen();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/don.t have permission/i);
    expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
  });

  const EMPTY_CATEGORIES = { ministries: [], sectors: [], themes: [], tags: [] };

  // Minors: a failed /page-types fetch used to leave the Page title picker silently empty.
  it("shows an error when /page-types fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/page-types") return jsonResponse(500, { error: "boom" });
        if (url === "/nrms/api/categories") return jsonResponse(200, EMPTY_CATEGORIES);
        return jsonResponse(200, []);
      }),
    );
    renderScreen();
    expect(await screen.findByText("Couldn't load page types.")).toBeInTheDocument();
  });

  // Minors: an empty /page-types list used to leave the form silently blocked with no
  // explanation.
  it("shows a clear message when /page-types comes back empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/page-types") return jsonResponse(200, []);
        if (url === "/nrms/api/categories") return jsonResponse(200, EMPTY_CATEGORIES);
        return jsonResponse(200, []);
      }),
    );
    renderScreen();
    expect(await screen.findByText("No page titles are set up yet. An administrator adds them under Release page titles.")).toBeInTheDocument();
  });

  it("an Editor still sees the real form (no permission message)", async () => {
    stubFetch({ roles: ["NRMS.Editor"] });
    renderScreen();
    expect(await screen.findByLabelText("Type")).toBeInTheDocument();
    expect(screen.queryByText(/don.t have permission/i)).not.toBeInTheDocument();
    // I5: document.title matches the h1.
    await waitFor(() => expect(document.title).toBe("New release — GCPE News Staff"));
  });

  const ACTIVITY = {
    id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
    ministryName: "Health", location: "Victoria", translations: ["French"], notEligible: null,
    prefill: { publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health", "education"], leadMinistryKey: "health", sectors: ["sector1"], themes: ["theme1"], tags: [] },
  };

  it("started from a Forecast activity, fills in legacy's fields from it and sends its id, location and planned time (New.aspx:625-700)", async () => {
    const calls = stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen("/releases/new?activity=4102");
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(screen.getByLabelText("Activity ID")).toHaveValue("4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());
    expect(screen.getByLabelText("Education")).toBeChecked();
    expect(screen.getByLabelText("Sector One")).toBeChecked();
    expect(screen.getByLabelText("Theme One")).toBeChecked();
    expect(screen.getByLabelText("Location")).toHaveValue("Victoria");
    expect(screen.getByText("Planned publish date: Jun 11, 2031 10:00 AM, from the activity. Change it in Publish settings.")).toBeInTheDocument();
    expect(screen.getByText("Translations required: French")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "Clinics open");
    await user.click(screen.getByRole("button", { name: "Create release" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/nrms/api/releases")?.body).toMatchObject({
      activityId: 4102, location: "Victoria", publishAt: "2031-06-11T17:00:00.000Z", ministries: ["health", "education"], leadMinistryKey: "health", sectors: ["sector1"], themes: ["theme1"],
    }));
  });

  it("an edit made before the Forecast lookup resolves is never overwritten by the pre-fill", async () => {
    let resolveLookup!: (r: Response) => void;
    const pendingLookup = new Promise<Response>((resolve) => {
      resolveLookup = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url === "/nrms/api/calendar-activities/4102") return pendingLookup;
        if (url === "/nrms/api/page-types") return jsonResponse(200, []);
        if (url === "/nrms/api/page-images") return jsonResponse(200, []);
        if (url === "/nrms/api/categories") {
          return jsonResponse(200, {
            ministries: [
              { key: "health", name: "Health" },
              { key: "education", name: "Education" },
            ],
            sectors: [],
            themes: [],
            tags: [],
          });
        }
        if (url === "/nrms/api/media-lists") return jsonResponse(200, []);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderScreen("/releases/new?activity=4102");
    expect(await screen.findByLabelText("Activity ID")).toHaveValue("4102");

    // The lookup is still in flight: edit fields the pre-fill would otherwise touch.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Headline", { exact: false }), "My own headline");
    await user.type(screen.getByLabelText("Location"), "My own city");
    await user.click(screen.getByLabelText("Health"));
    expect(screen.getByLabelText("Health")).toBeChecked();

    // Now let the lookup resolve: its pre-fill must not silently overwrite what the user typed.
    resolveLookup(jsonResponse(200, ACTIVITY));
    await screen.findByRole("link", { name: "Sample clinic opening" });

    expect(screen.getByLabelText("Headline", { exact: false })).toHaveValue("My own headline");
    expect(screen.getByLabelText("Location")).toHaveValue("My own city");
    expect(screen.getByLabelText("Health")).toBeChecked();
    expect(screen.getByLabelText("Education")).not.toBeChecked();
  });

  it("a typed id is looked up, and its fields are filled in only when asked", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Activity ID"), "4102");
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toBeInTheDocument();
    expect(screen.getByLabelText("Health")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Fill in from activity 4102" }));
    expect(screen.getByLabelText("Health")).toBeChecked();
  });

  it("retyping the Activity ID clears the untouched pre-fill, but never a field the user touched", async () => {
    const OTHER_ACTIVITY = {
      id: 4103, state: "found", title: "Other activity", startAt: null, endAt: null,
      ministryName: "Education", location: "Kamloops", translations: [], notEligible: null,
      prefill: { publishAt: null, location: "Kamloops", ministries: ["education"], leadMinistryKey: "education", sectors: [], themes: [], tags: [] },
    };
    stubFetch({ lookups: { "4102": ACTIVITY, "4103": OTHER_ACTIVITY } });
    renderScreen("/releases/new?activity=4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());
    expect(screen.getByLabelText("Location")).toHaveValue("Victoria");
    expect(screen.getByText(/Planned publish date:/)).toBeInTheDocument();

    // The user touches Location by hand before retyping the id.
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Location"));
    await user.type(screen.getByLabelText("Location"), "My own place");

    // Retype the Activity ID to a different activity: the untouched pre-fill (ministries,
    // the planned publish date) clears, but the touched Location survives.
    await user.clear(screen.getByLabelText("Activity ID"));
    await user.type(screen.getByLabelText("Activity ID"), "4103");
    await waitFor(() => expect(screen.getByLabelText("Health")).not.toBeChecked());
    expect(screen.getByLabelText("Education")).not.toBeChecked();
    expect(screen.queryByText(/Planned publish date:/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toHaveValue("My own place");
  });

  it("clearing the Activity ID clears the untouched pre-fill", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen("/releases/new?activity=4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Activity ID"));
    await waitFor(() => expect(screen.getByLabelText("Health")).not.toBeChecked());
    expect(screen.getByLabelText("Location")).toHaveValue("");
    expect(screen.queryByText(/Planned publish date:/)).not.toBeInTheDocument();
  });

  it("the explicit Fill in button overwrites a field the user already touched", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Health")); // touched, before any lookup
    await user.type(screen.getByLabelText("Activity ID"), "4102");
    await screen.findByRole("button", { name: "Fill in from activity 4102" });
    expect(screen.getByLabelText("Health")).toBeChecked();

    await user.click(screen.getByLabelText("Health")); // untouch it by hand: unchecked now
    expect(screen.getByLabelText("Health")).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Fill in from activity 4102" }));
    expect(screen.getByLabelText("Health")).toBeChecked();
    expect(screen.getByLabelText("Education")).toBeChecked();
  });

  it("an unknown or deleted id says so, offers nothing to fill in, and the server's refusal shows at the field", async () => {
    stubFetch({ lookups: {}, onPost: () => jsonResponse(422, { error: "bad", problems: ["No Calendar activity has ID 9999."] }) });
    renderScreen("/releases/new?activity=9999");
    expect(await screen.findByText("No Calendar activity has ID 9999.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fill in from/ })).toBeNull();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "A headline");
    await user.click(screen.getByRole("button", { name: "Create release" }));
    await waitFor(() => expect(screen.getByLabelText("Activity ID")).toHaveAttribute("aria-invalid", "true"));
  });

  it("has no serious or critical axe violations, filled in from an activity", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    const { container } = renderScreen("/releases/new?activity=4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
