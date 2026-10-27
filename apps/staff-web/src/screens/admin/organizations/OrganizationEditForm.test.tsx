import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { jsonResponse } from "../../../../test/jsonResponse";
import {
  OrganizationEditForm,
  SAVED_MESSAGE,
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
  const BIO_LABEL = "Remove the previous minister's biography";
  const BIO_WARNING =
    "The public page still shows the previous minister's biography.";

  it("hides the biography checkbox when the minister has no biography", () => {
    setup(false, undefined, NO_BIO);
    expect(screen.queryByLabelText(BIO_LABEL)).toBeNull();
  });

  it("shows the biography checkbox with its hint and sends exactly detailsHtml null", async () => {
    const { calls, user } = setup(false);
    const box = screen.getByLabelText(BIO_LABEL);
    expect(box).not.toBeChecked();
    expect(
      screen.getByText(
        "The biography on the public ministry page belongs to the current minister. Remove it when the minister changes.",
      ),
    ).toBeInTheDocument();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      minister: { detailsHtml: null },
    });
  });

  it("combines the biography removal with other minister changes", async () => {
    const { calls, user } = setup(false);
    const name = screen.getByLabelText("Minister name");
    await user.clear(name);
    await user.type(name, "Honourable New Person");
    await user.click(screen.getByLabelText(BIO_LABEL));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      minister: { name: "Honourable New Person", detailsHtml: null },
    });
  });

  it("warns when the minister name changes while the old biography stays", async () => {
    const { user } = setup(false);
    expect(screen.queryByText(BIO_WARNING)).toBeNull();
    await user.type(screen.getByLabelText("Minister name"), "x");
    expect(screen.getByText(BIO_WARNING)).toBeInTheDocument();
    await user.click(screen.getByLabelText(BIO_LABEL));
    expect(screen.queryByText(BIO_WARNING)).toBeNull();
  });

  it("does not warn about the biography when there is none", async () => {
    const { user } = setup(false, undefined, NO_BIO);
    await user.type(screen.getByLabelText("Minister name"), "x");
    expect(screen.queryByText(BIO_WARNING)).toBeNull();
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
});
