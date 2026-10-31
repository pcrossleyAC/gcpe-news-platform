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
  lastEdited: null,
};

function renderRow(item: ReleaseListItem, opts: { showLastEdited?: boolean; flagPassedPlanned?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ul>
        <ReleaseRow item={item} now={NOW} timeZone={TZ} {...opts} />
      </ul>
    </MemoryRouter>,
  );
}

describe("ReleaseRow", () => {
  // Suite review R8: "Planned" (only a plan; nothing goes out) looks different from "Scheduled".
  it("a Planned status has its own badge style; Scheduled keeps the plain one", () => {
    renderRow({ ...BASE, status: "approved", statusText: "Planned" });
    expect(screen.getByText("Planned")).toHaveClass("gcpe-badge", "gcpe-badge--planned");
    cleanup();
    renderRow({ ...BASE, status: "scheduled", statusText: "Scheduled" });
    expect(screen.getByText("Scheduled")).toHaveClass("gcpe-badge");
    expect(screen.getByText("Scheduled")).not.toHaveClass("gcpe-badge--planned");
  });

  it("on the Forecast, a planned release whose time has passed says so, as an alert", () => {
    const passed = { ...BASE, status: "approved" as const, statusText: "Planned", publishAt: "2026-06-15T16:00:00Z" };
    renderRow(passed, { flagPassedPlanned: true });
    const badge = screen.getByText("Planned time passed – not published");
    expect(badge).toHaveClass("gcpe-badge--alert");
    cleanup();
    // Elsewhere (Drafts) it stays "Planned"; and a planned time still ahead is never flagged.
    renderRow(passed);
    expect(screen.getByText("Planned")).toBeInTheDocument();
    cleanup();
    renderRow({ ...passed, publishAt: "2026-06-15T19:00:00Z" }, { flagPassedPlanned: true });
    expect(screen.getByText("Planned")).toBeInTheDocument();
  });


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

  it("a date within the week names its weekday and its date (Scheduled), not the weekday alone", () => {
    renderRow({ ...BASE, status: "scheduled", statusText: "Scheduled", publishAt: "2026-06-19T16:00:00Z" });
    expect(screen.getByText("Friday, Jun 19 9:00 AM")).toBeInTheDocument();
  });

  it("with showLastEdited (Drafts), says who last edited the release and when; never otherwise", () => {
    const item = { ...BASE, lastEdited: { at: "2026-06-15T17:30:00Z", by: "Pat Example" } };
    renderRow(item, { showLastEdited: true });
    expect(screen.getByText("Last edited Today 10:30 AM by Pat Example")).toBeInTheDocument();
    cleanup();
    renderRow(item);
    expect(screen.queryByText(/Last edited/)).toBeNull();
    cleanup();
    renderRow({ ...BASE, lastEdited: null }, { showLastEdited: true });
    expect(screen.queryByText(/Last edited/)).toBeNull();
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

  // The badge sits beside the status pill; when the status already reads "Approved" the badge
  // would only repeat it, so "Approved" shows once.
  it("shows the Approved badge only on a draft-folder item with approved=true, and never twice", () => {
    renderRow({ ...BASE, status: "draft", statusText: "Draft", approved: true });
    expect(screen.getByText("Approved", { selector: ".gcpe-release-row__approved" })).toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, status: "draft", statusText: "Draft", approved: false });
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, status: "approved", statusText: "Approved", approved: true });
    expect(screen.getAllByText("Approved")).toHaveLength(1);

    cleanup();
    // Approved once scheduled: the field is still true, but the Approved *badge* is specific
    // to the Drafts folder per the brief ("'Approved' badge on drafts with a reference").
    renderRow({ ...BASE, status: "scheduled", statusText: "Scheduled", approved: true });
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("doesn't repeat the location when the summary already starts with it (any case or punctuation)", () => {
    renderRow({ ...BASE, location: "KAMLOOPS", summary: "Kamloops - Starting in spring, a new express bus." });
    expect(screen.getByText("Kamloops - Starting in spring, a new express bus.")).toBeInTheDocument();
    expect(screen.queryByText(/KAMLOOPS –/)).not.toBeInTheDocument();

    cleanup();
    // Whole words only: "Victorians" doesn't start with the dateline "VICTORIA".
    renderRow({ ...BASE, location: "VICTORIA", summary: "Victorians will see new buses." });
    expect(screen.getByText("VICTORIA – Victorians will see new buses.")).toBeInTheDocument();
  });

  it("leaves out a page title that only restates the type, and keeps any other", () => {
    renderRow({ ...BASE, type: "release", pageTitle: "News Release" });
    expect(screen.queryByText("News Release")).not.toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, type: "advisory", pageTitle: "Media Advisory" });
    expect(screen.queryByText("Media Advisory")).not.toBeInTheDocument();

    cleanup();
    // Review P2: a title that merely ends with the type's word says something more.
    renderRow({ ...BASE, type: "release", pageTitle: "Joint News Release" });
    expect(screen.getByText("Joint News Release")).toBeInTheDocument();

    cleanup();
    renderRow({ ...BASE, type: "story", pageTitle: "Backgrounder Story" });
    expect(screen.getByText("Backgrounder Story")).toBeInTheDocument();
  });

  it("the headline is a heading, so a screen-reader user can move release to release", () => {
    renderRow(BASE);
    expect(screen.getByRole("heading", { name: "Province funds new schools" })).toBeInTheDocument();
  });

  it("shows the Approved badge on a failed item too — failed releases are in the Drafts folder", () => {
    // Fix round 1, finding 1: legacy shows the badge whenever the reference is set, and
    // FOLDER_STATUSES.drafts (apps/nrms/src/releases/queries.ts) is ["draft","approved","failed"].
    renderRow({ ...BASE, status: "failed", statusText: "Failed", approved: true });
    expect(screen.getByText("Approved", { selector: ".gcpe-release-row__approved" })).toBeInTheDocument();
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
