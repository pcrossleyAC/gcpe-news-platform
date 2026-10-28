import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { jsonResponse } from "../../../../test/jsonResponse";
import {
  ABBREVIATION_HINT,
  OrganizationEditForm,
  SAVED_MESSAGE,
  bioToPatch,
  deactivateWarning,
} from "./OrganizationEditForm";

const HEALTH: OrgRecord = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: {
    name: "Honourable Josie Osborne",
    summary: null,
    detailsHtml: "<p>x</p>",
    email: null,
    photoUrl: null,
    address: "PO BOX 1",
  },
  contact: {
    fullName: "A",
    phoneNumber: "",
    mobileNumber: "",
    emailAddress: "",
  },
  secondContact: null,
  weekendContactNumber: "",
  social: {
    twitterUsername: "",
    flickrUrl: null,
    youtubeUrl: null,
    audioUrl: null,
  },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  successorKeys: [],
  updatedAt: "2026-10-02T16:46:05.527-07:00",
} as OrgRecord;
const FINANCE = {
  ...HEALTH,
  key: "finance",
  displayName: "Finance",
} as OrgRecord;
const GONE = {
  ...HEALTH,
  key: "gone",
  displayName: "Gone Ministry",
  isActive: false,
} as OrgRecord;

function setup(
  isAdmin: boolean,
  patch: (init?: RequestInit) => Response = () => jsonResponse(200, HEALTH),
  org: OrgRecord = HEALTH,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return patch(init);
    }),
  );
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <OrganizationEditForm
      org={org}
      orgs={[HEALTH, FINANCE, GONE]}
      isAdmin={isAdmin}
      onSaved={onSaved}
      onCancel={onCancel}
    />,
  );
  return { calls, onSaved, onCancel, user: userEvent.setup() };
}

describe("OrganizationEditForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends only the changed fields", async () => {
    const { calls, user } = setup(false);
    const name = screen.getByLabelText("Minister name");
    await user.clear(name);
    await user.type(name, "Honourable New Person");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe("/core/api/organizations/health/profile");
    expect(calls[0]!.init!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      minister: { name: "Honourable New Person" },
    });
  });

  describe("minister photo", () => {
    const PHOTO =
      "https://www2.gov.bc.ca/assets/download/F41BD93F51AE4923A6B7E059AB96B133";
    const withPhoto = {
      ...HEALTH,
      minister: { ...HEALTH.minister, photoUrl: PHOTO },
    } as OrgRecord;

    it("uses a full-width field", () => {
      setup(false, undefined, withPhoto);
      expect(
        screen.getByLabelText("Minister photo URL").closest(".gcpe-field"),
      ).toHaveClass("gcpe-field--wide");
    });

    it("previews the stored photo", () => {
      setup(false, undefined, withPhoto);
      expect(
        screen.getByRole("img", { name: "Preview of the minister photo" }),
      ).toHaveAttribute("src", PHOTO);
    });

    it("updates the preview as the address changes", async () => {
      const { user } = setup(false, undefined, withPhoto);
      const field = screen.getByLabelText("Minister photo URL");
      await user.clear(field);
      await user.type(field, "https://boxs.ca/files/new-minister.jpg");
      expect(
        screen.getByRole("img", { name: "Preview of the minister photo" }),
      ).toHaveAttribute("src", "https://boxs.ca/files/new-minister.jpg");
    });

    it("shows no preview until the address starts with https://", async () => {
      const { user } = setup(false);
      expect(
        screen.queryByRole("img", { name: "Preview of the minister photo" }),
      ).toBeNull();
      await user.type(
        screen.getByLabelText("Minister photo URL"),
        "/files/new-minister.jpg",
      );
      expect(
        screen.queryByRole("img", { name: "Preview of the minister photo" }),
      ).toBeNull();
      expect(
        screen.getByText(
          "Enter the full address, starting with https://, to see a preview.",
        ),
      ).toBeInTheDocument();
    });

    it("says so when the address doesn't load an image, and clears that when the address changes", async () => {
      const { user } = setup(false, undefined, withPhoto);
      fireEvent.error(
        screen.getByRole("img", { name: "Preview of the minister photo" }),
      );
      expect(
        screen.getByText(
          "This address didn't load an image. Check that it's the right URL.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: "Preview of the minister photo" }),
      ).toBeNull();
      await user.type(screen.getByLabelText("Minister photo URL"), "x");
      expect(
        screen.queryByText(
          "This address didn't load an image. Check that it's the right URL.",
        ),
      ).toBeNull();
      expect(
        screen.getByRole("img", { name: "Preview of the minister photo" }),
      ).toBeInTheDocument();
    });
  });

  it("shows the saved message and calls onSaved", async () => {
    const { onSaved, user } = setup(false);
    await user.type(screen.getByLabelText("Minister summary"), "Hi");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved. The public Ministries page updates when the site next rebuilds.",
    );
    expect(SAVED_MESSAGE).toBe(
      "Saved. The public Ministries page updates when the site next rebuilds.",
    );
    expect(onSaved).toHaveBeenCalledWith(HEALTH);
  });

  it("warns but allows an empty minister name", async () => {
    const { user } = setup(false);
    await user.clear(screen.getByLabelText("Minister name"));
    expect(
      screen.getByText(
        "This ministry will show no minister on the public site.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("blocks an empty ministry name", async () => {
    const { user } = setup(false);
    await user.clear(screen.getByLabelText(/Ministry name/));
    expect(screen.getByText("Enter a ministry name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a SiteEditor doesn't see Parent ministry or Active", () => {
    setup(false);
    expect(screen.queryByLabelText("Parent ministry")).toBeNull();
    expect(screen.queryByLabelText("Active")).toBeNull();
  });

  it("an admin sees them and can set the parent, without offering itself or inactive orgs", async () => {
    const { calls, user } = setup(true);
    const parent = screen.getByLabelText("Parent ministry");
    expect(screen.getByLabelText("Active")).toBeChecked();
    expect(screen.queryByRole("option", { name: "Health" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Gone Ministry" })).toBeNull();
    await user.selectOptions(parent, "finance");
    await user.click(screen.getByLabelText("Active"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      parentKey: "finance",
      isActive: false,
    });
  });

  it("shows server validation messages", async () => {
    const { onSaved, user } = setup(false, () =>
      jsonResponse(400, {
        error: "invalid request",
        issues: [
          {
            code: "invalid_string",
            validation: "email",
            path: ["minister", "email"],
            message: "Invalid email",
          },
        ],
      }),
    );
    await user.type(screen.getByLabelText("Minister email"), "nope");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("moves focus to the heading on open and cancels", async () => {
    const { onCancel, user } = setup(false);
    expect(screen.getByRole("heading", { name: "Edit Health" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  const NO_BIO = {
    ...HEALTH,
    minister: { ...HEALTH.minister, detailsHtml: null },
  } as OrgRecord;
  const PREVIOUS_MINISTER_NOTE =
    "The biography still describes the previous minister.";
  const sentBody = (calls: { init?: RequestInit }[]) =>
    JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;

  describe("minister biography", () => {
    const bio = () => screen.getByRole("textbox", { name: "Minister biography" });

    it("opens with the stored biography in the editor and saves an edit as minister.detailsHtml", async () => {
      const { calls, user } = setup(false);
      const field = bio();
      expect(field.innerHTML).toContain("<p>x</p>");
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining(
          "Shown on the minister's biography page, linked as Read Bio from the ministry page. Leave it empty for no biography page.",
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Insert asset" }),
      ).toBeNull();
      expect(
        screen.queryByLabelText("Remove the previous minister's biography"),
      ).toBeNull();
      await user.click(field);
      await user.type(field, "yz");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      const sent = sentBody(calls) as { minister: { detailsHtml: string } };
      expect(Object.keys(sent)).toEqual(["minister"]);
      expect(Object.keys(sent.minister)).toEqual(["detailsHtml"]);
      expect(sent.minister.detailsHtml).toBe("<p>xyz</p>");
    });

    it("emptying the biography sends minister.detailsHtml: null", async () => {
      const { calls, user } = setup(false);
      await user.click(screen.getByRole("button", { name: "Clear the biography" }));
      expect(bio()).toHaveFocus();
      expect(bio().textContent).toBe("");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({ minister: { detailsHtml: null } });
    });

    it("bioToPatch treats editor HTML with no text as null", () => {
      expect(bioToPatch("<p></p>")).toBeNull();
      expect(bioToPatch("<p> </p><ul><li><p></p></li></ul>")).toBeNull();
      expect(bioToPatch("<p>&nbsp;</p>")).toBeNull();
      expect(bioToPatch("")).toBeNull();
      expect(bioToPatch("<p>Hi</p>")).toBe("<p>Hi</p>");
    });

    it("an untouched biography is not sent", async () => {
      const { calls, user } = setup(false);
      await user.type(screen.getByLabelText("Minister summary"), "Hi");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({ minister: { summary: "Hi" } });
    });

    it("a stored biography the editor would rewrite (<b>, line breaks) is not sent untouched", async () => {
      const { calls, user } = setup(false, undefined, {
        ...HEALTH,
        minister: { ...HEALTH.minister, detailsHtml: "<p>a</p>\r\n<p>b <b>c</b></p>" },
      } as OrgRecord);
      expect(bio().innerHTML).toContain("<strong>c</strong>");
      await user.type(screen.getByLabelText("Minister summary"), "Hi");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({ minister: { summary: "Hi" } });
    });

    it("a stored biography with no text (<p>&nbsp;</p>) is not sent as null on an unrelated save", async () => {
      const { calls, user } = setup(false, undefined, {
        ...HEALTH,
        minister: { ...HEALTH.minister, detailsHtml: "<p>&nbsp;</p>" },
      } as OrgRecord);
      await user.type(screen.getByLabelText("Minister summary"), "Hi");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({ minister: { summary: "Hi" } });
    });

    it("an empty biography stays unsent, and offers no Clear button", async () => {
      const { user } = setup(false, undefined, NO_BIO);
      expect(bio().textContent).toBe("");
      expect(
        screen.queryByRole("button", { name: "Clear the biography" }),
      ).toBeNull();
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
    });

    it("renaming the minister without touching the biography shows the previous-minister note", async () => {
      const { calls, user } = setup(false);
      expect(screen.queryByText(PREVIOUS_MINISTER_NOTE)).toBeNull();
      const name = screen.getByLabelText("Minister name");
      await user.clear(name);
      await user.type(name, "Honourable New Person");
      expect(screen.getByText(PREVIOUS_MINISTER_NOTE)).toBeInTheDocument();
      expect(bio()).toHaveAccessibleDescription(
        expect.stringContaining(PREVIOUS_MINISTER_NOTE),
      );
      await user.click(screen.getByRole("button", { name: "Clear the biography" }));
      expect(screen.queryByText(PREVIOUS_MINISTER_NOTE)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({
        minister: { name: "Honourable New Person", detailsHtml: null },
      });
    });

    it("does not show the previous-minister note when there is no biography", async () => {
      const { user } = setup(false, undefined, NO_BIO);
      await user.type(screen.getByLabelText("Minister name"), "x");
      expect(screen.queryByText(PREVIOUS_MINISTER_NOTE)).toBeNull();
    });

    it("a server biography error shows beside the editor", async () => {
      const { user } = setup(false, () =>
        jsonResponse(400, {
          error: "invalid request",
          issues: [
            {
              code: "custom",
              path: ["minister", "detailsHtml"],
              message: "Keep the biography to 20,000 characters or fewer.",
            },
          ],
        }),
      );
      await user.click(bio());
      await user.type(bio(), "more");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(bio()).toHaveAccessibleDescription(
          expect.stringContaining("Keep the biography to 20,000 characters or fewer."),
        ),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Fix the problems shown below, then save.",
      );
    });
  });

  describe("Meet the Team links", () => {
    const team = () => screen.getByRole("group", { name: "Meet the Team links" });
    const CABINET = { text: "Cabinet Ministers", url: "/cabinet" };

    it("shows its description and the stored links; a record without teamLinks shows none", () => {
      setup(false, undefined, { ...HEALTH, teamLinks: [CABINET] } as OrgRecord);
      expect(team()).toHaveAccessibleDescription(
        "Shown as Meet the Team on the ministry page (the Office of the Premier uses it for Cabinet Ministers, Deputy Ministers and Cabinet Committees).",
      );
      const row = within(team()).getByRole("group", { name: "Link 1" });
      expect(within(row).getByLabelText("Link text")).toHaveValue("Cabinet Ministers");
      cleanup();
      setup(false);
      expect(within(team()).getByText("No links yet.")).toBeInTheDocument();
    });

    it("adds a Meet the Team link and sends teamLinks whole; a server teamLinks[0].url error shows beside that row", async () => {
      const { calls, user } = setup(
        false,
        () =>
          jsonResponse(400, {
            error: "invalid request",
            issues: [
              {
                code: "custom",
                path: ["teamLinks", 1, "url"],
                message: "Must start with https:// or / (a page on this site).",
              },
            ],
          }),
        { ...HEALTH, teamLinks: [CABINET] } as OrgRecord,
      );
      // A blank row in the middle is dropped, so the server's index 1 is the third row on screen.
      await user.click(within(team()).getByRole("button", { name: "+ Add a link" }));
      await user.click(within(team()).getByRole("button", { name: "+ Add a link" }));
      const row3 = within(team()).getByRole("group", { name: "Link 3" });
      await user.type(within(row3).getByLabelText("Link text"), "Deputy Ministers");
      await user.type(within(row3).getByLabelText("Web address"), "deputies");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({
        teamLinks: [CABINET, { text: "Deputy Ministers", url: "deputies" }],
      });
      expect(
        await within(
          within(team()).getByRole("group", { name: "Link 3" }),
        ).findByText("Must start with https:// or / (a page on this site)."),
      ).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Fix the problems shown below, then save.",
      );
    });

    it("an untouched list is not sent, even when the record had no teamLinks", async () => {
      const { user } = setup(false);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
    });
  });

  describe("media contacts", () => {
    const contacts = () => screen.getByRole("group", { name: "Media contacts" });
    const primary = () =>
      within(contacts()).getByRole("group", { name: "Primary contact" });
    const alternate = () =>
      within(contacts()).getByRole("group", { name: "Alternate contact" });

    it("shows the stored contacts with phone and email input types", () => {
      setup(false, undefined, {
        ...HEALTH,
        contact: {
          fullName: "Pat Doe",
          phoneNumber: "250 555-0100",
          mobileNumber: "250 555-0101",
          emailAddress: "pat.doe@gov.bc.ca",
        },
        weekendContactNumber: "250 555-0199",
      } as OrgRecord);
      expect(within(primary()).getByLabelText("Name")).toHaveValue("Pat Doe");
      const phone = within(primary()).getByLabelText("Phone");
      expect(phone).toHaveValue("250 555-0100");
      expect(phone).toHaveAttribute("type", "tel");
      expect(phone).toHaveAccessibleDescription("Shown as Direct on the ministry page.");
      expect(within(primary()).getByLabelText("Cell")).toHaveAttribute("type", "tel");
      expect(within(primary()).getByLabelText("Email")).toHaveAttribute("type", "email");
      expect(within(primary()).getByLabelText("Email")).toHaveValue("pat.doe@gov.bc.ca");
      expect(within(alternate()).getByLabelText("Name")).toHaveValue("");
      const afterHours = within(contacts()).getByLabelText("After-hours phone");
      expect(afterHours).toHaveValue("250 555-0199");
      expect(afterHours).toHaveAttribute("type", "tel");
    });

    it("edits the primary contact and sends contact with all four fields; an emailAddress error shows beside Primary email", async () => {
      const { calls, user, onSaved } = setup(false, () =>
        jsonResponse(400, {
          error: "invalid request",
          issues: [
            {
              code: "invalid_string",
              path: ["contact", "emailAddress"],
              message: "Enter an email address like name@gov.bc.ca.",
            },
          ],
        }),
      );
      await user.type(within(primary()).getByLabelText("Email"), " nope ");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({
        contact: {
          fullName: "A",
          phoneNumber: "",
          mobileNumber: "",
          emailAddress: "nope",
        },
      });
      const email = within(primary()).getByLabelText("Email");
      await waitFor(() =>
        expect(email).toHaveAccessibleDescription(
          "Enter an email address like name@gov.bc.ca.",
        ),
      );
      expect(email).toHaveAttribute("aria-invalid", "true");
      expect(within(alternate()).getByLabelText("Email")).not.toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Fix the problems shown below, then save.",
      );
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("an alternate added where none was stored is sent whole as secondContact", async () => {
      const { calls, user } = setup(false);
      await user.type(within(alternate()).getByLabelText("Name"), "Sam Roe");
      await user.type(within(alternate()).getByLabelText("Cell"), "250 555-0102");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({
        secondContact: {
          fullName: "Sam Roe",
          phoneNumber: "",
          mobileNumber: "250 555-0102",
          emailAddress: "",
        },
      });
    });

    it("form: editing Additional display name sends displayAdditionalName; untouched is not sent", async () => {
      const first = setup(false);
      expect(screen.getByText(/Shown in brackets under the ministry on the Media Contacts page, for example \(Child Care\)\./)).toBeTruthy();
      await first.user.type(screen.getByLabelText("Additional display name"), " (Child Care) ");
      await first.user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(first.calls).toHaveLength(1));
      expect(sentBody(first.calls)).toEqual({ displayAdditionalName: "(Child Care)" });
    });

    it("a blank Additional display name sends an empty string; nothing is sent when untouched", async () => {
      const filled = setup(false, undefined, { ...HEALTH, displayAdditionalName: "(Child Care)" });
      await filled.user.clear(screen.getByLabelText("Additional display name"));
      await filled.user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(filled.calls).toHaveLength(1));
      expect(sentBody(filled.calls)).toEqual({ displayAdditionalName: "" });
    });

    it("sends weekendContactNumber when the after-hours phone changes", async () => {
      const { calls, user } = setup(false);
      await user.type(
        within(contacts()).getByLabelText("After-hours phone"),
        " 250 555-0199 ",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sentBody(calls)).toEqual({ weekendContactNumber: "250 555-0199" });
    });

    it("a record with no contacts at all opens blank and sends nothing untouched", async () => {
      const { user } = setup(false, undefined, {
        ...HEALTH,
        contact: null,
        secondContact: null,
        weekendContactNumber: null,
      } as OrgRecord);
      expect(within(primary()).getByLabelText("Name")).toHaveValue("");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
    });

    it("notes when only the alternate is filled", async () => {
      const { user } = setup(false, undefined, {
        ...HEALTH,
        contact: null,
      } as OrgRecord);
      const NOTE = "The public page shows the alternate only with a primary contact.";
      expect(screen.queryByText(NOTE)).toBeNull();
      await user.type(within(alternate()).getByLabelText("Name"), "Sam Roe");
      expect(screen.getByText(NOTE)).toBeInTheDocument();
      await user.type(within(primary()).getByLabelText("Name"), "Pat");
      expect(screen.queryByText(NOTE)).toBeNull();
    });
  });

  it("a SiteEditor (not Core.Admin) sees and can save biography, team links and contacts", async () => {
    const { calls, user } = setup(false, () => jsonResponse(200, HEALTH), NO_BIO);
    const field = screen.getByRole("textbox", { name: "Minister biography" });
    await user.click(field);
    await user.type(field, "New bio");
    const team = screen.getByRole("group", { name: "Meet the Team links" });
    await user.click(within(team).getByRole("button", { name: "+ Add a link" }));
    await user.type(within(team).getByLabelText("Link text"), "Cabinet Ministers");
    await user.type(within(team).getByLabelText("Web address"), "/cabinet");
    const primary = screen.getByRole("group", { name: "Primary contact" });
    await user.type(within(primary).getByLabelText("Phone"), "250 555-0100");
    await user.type(screen.getByLabelText("After-hours phone"), "250 555-0199");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sentBody(calls)).toEqual({
      minister: { detailsHtml: "<p>New bio</p>" },
      teamLinks: [{ text: "Cabinet Ministers", url: "/cabinet" }],
      contact: {
        fullName: "A",
        phoneNumber: "250 555-0100",
        mobileNumber: "",
        emailAddress: "",
      },
      weekendContactNumber: "250 555-0199",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(SAVED_MESSAGE);
  });

  it("orders the new fields after Minister photo URL: biography, Meet the Team links, Media contacts, then Ministry page links", () => {
    setup(false);
    const order = [
      screen.getByLabelText("Minister photo URL"),
      screen.getByRole("textbox", { name: "Minister biography" }),
      screen.getByRole("group", { name: "Meet the Team links" }),
      screen.getByRole("group", { name: "Media contacts" }),
      screen.getByRole("group", { name: "Ministry page links" }),
    ];
    for (let i = 1; i < order.length; i++)
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
  });

  it("unchecking Active shows the subscriber warning before Save", async () => {
    const { calls, user } = setup(true);
    expect(screen.queryByText(deactivateWarning("Health"))).toBeNull();
    await user.click(screen.getByLabelText("Active"));
    expect(
      screen.getByText(
        "Deactivate Health? It disappears from the public site, and its subscribers stop receiving news. This can be undone with Reactivate, but subscribers are not moved to another ministry.",
      ),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByLabelText("Active"));
    expect(screen.queryByText(deactivateWarning("Health"))).toBeNull();
  });

  it("does not send isActive or parentKey the user did not touch, even if the org prop changed since opening", async () => {
    const { calls, user } = setup(true);
    cleanup();
    calls.length = 0;
    const onSaved = vi.fn();
    const view = render(
      <OrganizationEditForm
        org={HEALTH}
        orgs={[HEALTH, FINANCE, GONE]}
        isAdmin
        onSaved={onSaved}
        onCancel={() => {}}
      />,
    );
    // Deactivated elsewhere (row button) while this form stayed open.
    view.rerender(
      <OrganizationEditForm
        org={{ ...HEALTH, isActive: false, parentKey: "finance" }}
        orgs={[HEALTH, FINANCE, GONE]}
        isAdmin
        onSaved={onSaved}
        onCancel={() => {}}
      />,
    );
    const name = screen.getByLabelText("Minister name");
    await user.clear(name);
    await user.type(name, "Honourable New Person");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      minister: { name: "Honourable New Person" },
    });
  });

  describe("ministry page links", () => {
    const TOPIC_A = { text: "Wildfire", url: "https://www2.gov.bc.ca/wildfire" };
    const TOPIC_B = { text: "Contact", url: "/contact" };
    const SERVICE = { text: "Permits", url: "https://permits.gov.bc.ca" };
    const LINKED = {
      ...HEALTH,
      url: "https://www2.gov.bc.ca/health",
      social: {
        ...HEALTH.social,
        flickrUrl: "https://www.flickr.com/photos/bcgovphotos",
      },
      topicLinks: [TOPIC_A, TOPIC_B],
      serviceLinks: [SERVICE],
    } as OrgRecord;
    const sent = (calls: { init?: RequestInit }[]) =>
      JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    const topics = () => screen.getByRole("group", { name: "Featured Topics" });
    const services = () =>
      screen.getByRole("group", { name: "Featured Services" });

    it("shows the current addresses and links in a Ministry page links group", () => {
      setup(false, undefined, LINKED);
      const group = screen.getByRole("group", { name: "Ministry page links" });
      expect(within(group).getByLabelText("Ministry website")).toHaveValue(
        "https://www2.gov.bc.ca/health",
      );
      expect(
        within(group).getByLabelText("Photos (Flickr) address"),
      ).toHaveValue("https://www.flickr.com/photos/bcgovphotos");
      expect(
        within(group).getByLabelText("Videos (YouTube) address"),
      ).toHaveValue("");
      const row2 = within(topics()).getByRole("group", { name: "Link 2" });
      expect(within(row2).getByLabelText("Link text")).toHaveValue("Contact");
      expect(within(row2).getByLabelText("Web address")).toHaveValue(
        "/contact",
      );
      expect(
        within(services()).getByRole("group", { name: "Link 1" }),
      ).toBeInTheDocument();
    });

    it("sends only a changed address, and social addresses under social", async () => {
      const { calls, user } = setup(false, undefined, LINKED);
      await user.clear(screen.getByLabelText("Ministry website"));
      await user.type(
        screen.getByLabelText("Ministry website"),
        "https://gov.bc.ca/health ",
      );
      await user.type(
        screen.getByLabelText("Videos (YouTube) address"),
        "https://youtube.com/bcgov",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sent(calls)).toEqual({
        url: "https://gov.bc.ca/health",
        social: { youtubeUrl: "https://youtube.com/bcgov" },
      });
    });

    it("reorder and remove send each changed list whole, and nothing else", async () => {
      const { calls, user } = setup(false, undefined, LINKED);
      await user.click(
        within(topics()).getByRole("button", { name: "Move link 2 up" }),
      );
      await user.click(
        within(services()).getByRole("button", { name: "Remove link 1" }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sent(calls)).toEqual({
        topicLinks: [TOPIC_B, TOPIC_A],
        serviceLinks: [],
      });
    });

    it("adds a link; a row left blank is dropped", async () => {
      const { calls, user } = setup(false);
      await user.click(
        within(topics()).getByRole("button", { name: "+ Add a link" }),
      );
      const row = within(topics()).getByRole("group", { name: "Link 1" });
      await user.type(within(row).getByLabelText("Link text"), "Vaccines");
      await user.type(
        within(row).getByLabelText("Web address"),
        "https://immunizebc.ca",
      );
      await user.click(
        within(topics()).getByRole("button", { name: "+ Add a link" }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(sent(calls)).toEqual({
        topicLinks: [{ text: "Vaccines", url: "https://immunizebc.ca" }],
      });
    });

    it("shows a server issue on its link row and on its address field", async () => {
      const { onSaved, user } = setup(
        false,
        () =>
          jsonResponse(400, {
            error: "invalid request",
            issues: [
              {
                code: "custom",
                path: ["topicLinks", 1, "url"],
                message: "Must start with https:// or / (a page on this site).",
              },
              {
                code: "custom",
                path: ["social", "flickrUrl"],
                message: "Must start with https://.",
              },
            ],
          }),
        LINKED,
      );
      await user.click(
        within(topics()).getByRole("button", { name: "Move link 2 up" }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      const row2 = within(topics()).getByRole("group", { name: "Link 2" });
      expect(
        await within(row2).findByText(
          "Must start with https:// or / (a page on this site).",
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Photos (Flickr) address")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(
        screen.getByLabelText("Photos (Flickr) address"),
      ).toHaveAccessibleDescription("Must start with https://.");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Fix the problems shown below, then save.",
      );
      expect(onSaved).not.toHaveBeenCalled();
    });
  });

  describe("abbreviation", () => {
    it("is shown only to Core.Admin, with its hint", () => {
      setup(false);
      expect(screen.queryByLabelText("Abbreviation")).toBeNull();
      cleanup();
      setup(true);
      const field = screen.getByLabelText("Abbreviation");
      expect(field).toHaveValue("HLTH");
      expect(field).toHaveAccessibleDescription(ABBREVIATION_HINT);
      expect(ABBREVIATION_HINT).toBe(
        "Used in release numbers, e.g. 2026HLTH0001. Changing it affects only releases approved from now on.",
      );
    });

    it("sends a changed abbreviation trimmed and upper-cased, and not an unchanged one", async () => {
      const { calls, user } = setup(true);
      const field = screen.getByLabelText("Abbreviation");
      await user.clear(field);
      await user.type(field, " hlth ");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
      await user.clear(field);
      await user.type(field, "health1");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        abbreviation: "HEALTH1",
      });
    });

    it("a 409 names the ministry that already uses it, on the field", async () => {
      const { onSaved, user } = setup(true, () =>
        jsonResponse(409, { error: "abbreviation-taken", takenBy: "Finance" }),
      );
      const field = screen.getByLabelText("Abbreviation");
      await user.clear(field);
      await user.type(field, "FIN");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(field).toHaveAccessibleDescription(
          expect.stringContaining(
            "That abbreviation is already used by Finance.",
          ),
        ),
      );
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("a 400 shows the format message on the field", async () => {
      const { user } = setup(true, () =>
        jsonResponse(400, {
          error: "invalid request",
          issues: [
            {
              code: "invalid_string",
              path: ["abbreviation"],
              message: "Use 2 to 10 capital letters or digits, e.g. HLTH.",
            },
          ],
        }),
      );
      const field = screen.getByLabelText("Abbreviation");
      await user.clear(field);
      await user.type(field, "H");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(field).toHaveAccessibleDescription(
          expect.stringContaining(
            "Use 2 to 10 capital letters or digits, e.g. HLTH.",
          ),
        ),
      );
    });
  });
});
