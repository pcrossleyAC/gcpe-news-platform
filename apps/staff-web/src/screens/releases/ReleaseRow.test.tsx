import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReleaseListItem } from "@gcpe/nrms-contract";
import { ReleaseRow } from "./ReleaseRow";

const TZ = "America/Vancouver";
const NOW = new Date("2026-06-15T18:00:00Z"); // 2026-06-15 11:00 PDT

const BASE: ReleaseListItem = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "release",
  key: "2026EDU0001-000123",
  reference: "123",
  status: "draft",
  statusText: "Approved",
  leadOrganization: "Education",
  pageTitle: "Funding for schools",
  headline: "Province funds new schools",
  location: "VICTORIA",
  summary: "New funding announced today.",
  publishAt: "2026-06-16T16:00:00Z", // 2026-06-16 09:00 PDT
  releasedAt: null,
  activityId: 54321,
  approved: true,
  flickrAlert: null,
};

function renderRow(item: ReleaseListItem) {
  return render(
    <MemoryRouter>
      <ul>
        <ReleaseRow item={item} now={NOW} timeZone={TZ} />
      </ul>
    </MemoryRouter>,
  );
}

describe("ReleaseRow", () => {
  afterEach(() => cleanup());

  it("renders the type label, organisation, page title, headline link, location-summary, status/date and Calendar id", () => {
    renderRow(BASE);
    expect(screen.getByText("Release")).toBeInTheDocument();
    expect(screen.getByText("Education")).toBeInTheDocument();
    expect(screen.getByText("Funding for schools")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Province funds new schools" });
    expect(link).toHaveAttribute("href", "/releases/11111111-1111-1111-1111-111111111111");
    expect(screen.getByText("VICTORIA – New funding announced today.")).toBeInTheDocument();
    expect(screen.getByText("Approved", { selector: ".gcpe-release-row__status-text" })).toBeInTheDocument();
    expect(screen.getByText(/Tomorrow 9:00 AM/)).toBeInTheDocument(); // publishAt, this item is a draft
    expect(screen.getByText(/54321/)).toBeInTheDocument();
  });

  it("uses releasedAt (not publishAt) for a published item", () => {
    renderRow({ ...BASE, status: "published", statusText: "Published", publishAt: null, releasedAt: "2026-06-14T18:00:00Z" });
    expect(screen.getByText(/Yesterday 11:00 AM/)).toBeInTheDocument();
  });

  it("omits the location-summary dash when either side is empty", () => {
    renderRow({ ...BASE, location: "", summary: "New funding announced today." });
    expect(screen.getByText("New funding announced today.")).toBeInTheDocument();
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, location: "VICTORIA", summary: "" });
    expect(screen.getByText("VICTORIA")).toBeInTheDocument();
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, location: "", summary: "" });
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();
  });

  it("shows no date text when there's no publishAt/releasedAt to show", () => {
    renderRow({ ...BASE, status: "draft", statusText: "Draft", publishAt: null, approved: false, reference: null });
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText(/AM|PM/)).not.toBeInTheDocument();
  });

  it("omits the Calendar activity line when activityId is unset", () => {
    renderRow({ ...BASE, activityId: null });
    expect(screen.queryByText(/Calendar/)).not.toBeInTheDocument();
  });

  it("shows the Approved badge only on a draft/approved item with approved=true", () => {
    renderRow({ ...BASE, status: "draft", approved: true });
    expect(screen.getByText("Approved", { selector: ".gcpe-badge" })).toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, status: "draft", approved: false });
    expect(screen.queryByText("Approved", { selector: ".gcpe-badge" })).not.toBeInTheDocument();

    cleanup();
    // Approved once scheduled: the field is still true, but the Approved *badge* is specific
    // to the Drafts folder per the brief ("'Approved' badge on drafts with a reference").
    renderRow({ ...BASE, status: "scheduled", statusText: "Scheduled", approved: true });
    expect(screen.queryByText("Approved", { selector: ".gcpe-badge" })).not.toBeInTheDocument();
  });

  it("shows a Flickr alert badge with the alert text as its accessible description", () => {
    renderRow({ ...BASE, flickrAlert: "The Flickr photo could not be made public." });
    const badge = screen.getByText("Flickr alert");
    expect(badge).toHaveAccessibleDescription("The Flickr photo could not be made public.");
  });

  it("shows no Flickr alert badge when flickrAlert is null", () => {
    renderRow({ ...BASE, flickrAlert: null });
    expect(screen.queryByText("Flickr alert")).not.toBeInTheDocument();
  });

  it("the colour bar is decorative and the type label is still visible text", () => {
    const { container } = renderRow(BASE);
    const bar = container.querySelector(".gcpe-release-row__bar");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Release")).toBeVisible();
  });
});
