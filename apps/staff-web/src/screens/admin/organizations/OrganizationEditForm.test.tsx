import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { jsonResponse } from "../../../../test/jsonResponse";
import { OrganizationEditForm, SAVED_MESSAGE } from "./OrganizationEditForm";

const HEALTH: OrgRecord = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Josie Osborne", summary: null, detailsHtml: "<p>x</p>", email: null, photoUrl: null, address: "PO BOX 1" },
  contact: { fullName: "A", phoneNumber: "", mobileNumber: "", emailAddress: "" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  updatedAt: "2026-10-02T16:46:05.527-07:00",
} as OrgRecord;
const FINANCE = { ...HEALTH, key: "finance", displayName: "Finance" } as OrgRecord;
const GONE = { ...HEALTH, key: "gone", displayName: "Gone Ministry", isActive: false } as OrgRecord;

function setup(isAdmin: boolean, patch: (init?: RequestInit) => Response = () => jsonResponse(200, HEALTH)) {
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
  render(<OrganizationEditForm org={HEALTH} orgs={[HEALTH, FINANCE, GONE]} isAdmin={isAdmin} onSaved={onSaved} onCancel={onCancel} />);
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
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ minister: { name: "Honourable New Person" } });
  });

  it("shows the saved message and calls onSaved", async () => {
    const { onSaved, user } = setup(false);
    await user.type(screen.getByLabelText("Minister summary"), "Hi");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved. The public Ministries page updates when the site next rebuilds.");
    expect(SAVED_MESSAGE).toBe("Saved. The public Ministries page updates when the site next rebuilds.");
    expect(onSaved).toHaveBeenCalledWith(HEALTH);
  });

  it("warns but allows an empty minister name", async () => {
    const { user } = setup(false);
    await user.clear(screen.getByLabelText("Minister name"));
    expect(screen.getByText("This ministry will show no minister on the public site.")).toBeInTheDocument();
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
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ parentKey: "finance", isActive: false });
  });

  it("shows server validation messages", async () => {
    const { onSaved, user } = setup(false, () => jsonResponse(400, { error: "invalid", issues: [{ message: "Enter a valid email address." }] }));
    await user.type(screen.getByLabelText("Minister email"), "nope");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("moves focus to the heading on open and cancels", async () => {
    const { onCancel, user } = setup(false);
    expect(screen.getByRole("heading", { name: "Edit Health" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
