import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { HeaderSection } from "./HeaderSection";

afterEach(() => cleanup());

describe("HeaderSection", () => {
  it("renders exactly one h1 with the first document's English headline", () => {
    render(<HeaderSection view={releaseView()} />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Clinics open");
  });

  // I5: document.title matches the h1 (the release's own headline).
  it("sets the document title to the headline", () => {
    render(<HeaderSection view={releaseView()} />);
    expect(document.title).toBe(`${screen.getByRole("heading", { level: 1 }).textContent} — GCPE News Staff`);
  });

  it("falls back to (untitled) with no documents", () => {
    render(<HeaderSection view={releaseView({ documents: [] })} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("(untitled)");
  });

  it("shows the type label and status text", () => {
    render(<HeaderSection view={releaseView({ type: "story", status: "draft", reference: null, publishAt: null })} />);
    expect(screen.getByText("Story")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows the reference once approved, in preference to the key", () => {
    render(<HeaderSection view={releaseView({ reference: "NEWS-00042", key: "2026HLTH0001-000042" })} />);
    expect(screen.getByText("NEWS-00042")).toBeInTheDocument();
  });

  it("shows the key when there is no reference yet", () => {
    render(<HeaderSection view={releaseView({ reference: null, key: "my-draft-slug" })} />);
    expect(screen.getByText("my-draft-slug")).toBeInTheDocument();
  });

  it("shows lastError as an alert", () => {
    render(<HeaderSection view={releaseView({ lastError: "Flickr upload timed out." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Flickr upload timed out.");
  });

  it("shows the Flickr alert", () => {
    render(<HeaderSection view={releaseView({ flickrAlert: "Went out without its photo." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Went out without its photo.");
  });

  // forms-b #16 and #13: the to-do lists are shown once, under Actions, with links; the header
  // only says how many things are left, links to that list, and is for editors (viewers have no Actions).
  it("an editor sees how many things are left and a link to the list under Actions, not a second copy of it", () => {
    render(<HeaderSection view={releaseView({ type: "release", status: "draft", ministries: [], documents: [] })} canEdit />);
    expect(screen.getByText(/^Not ready: 2 things to fix\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See them under Actions" })).toHaveAttribute("href", "#actions-approve-why");
    expect(screen.queryByText("Choose at least one ministry.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Before this can be/)).not.toBeInTheDocument();
  });

  it("an approved release links to the publish list, and says 1 thing", () => {
    render(<HeaderSection view={releaseView({ status: "approved", reference: "NEWS-00001", key: "k", documents: [] })} canEdit />);
    expect(screen.getByText(/^Not ready: 1 thing to fix\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See them under Actions" })).toHaveAttribute("href", "#actions-publish-why");
  });

  it("says nothing when the release is ready, for a viewer, or once nothing under Actions can act on it", () => {
    const { rerender } = render(<HeaderSection view={releaseView({ type: "release", status: "draft", ministries: ["health"], leadMinistryKey: "health" })} canEdit />);
    expect(screen.queryByText(/Not ready/)).not.toBeInTheDocument();
    rerender(<HeaderSection view={releaseView({ type: "release", status: "draft", ministries: [] })} />);
    expect(screen.queryByText(/Not ready/)).not.toBeInTheDocument();
    rerender(<HeaderSection view={releaseView({ type: "release", status: "published", live: true })} canEdit />);
    expect(screen.queryByText(/Not ready/)).not.toBeInTheDocument();
  });

  // Fix round 1, finding 2: every publish re-checks publishProblems (a correction, a schedule
  // firing), so a published or scheduled release with something missing says so too.
  it("a published release with no sector: 1 thing, linked to the list under Actions", () => {
    render(<HeaderSection view={releaseView({ type: "release", status: "published", live: true, sectors: [] })} canEdit />);
    expect(screen.getByText(/^Not ready: 1 thing to fix\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See them under Actions" })).toHaveAttribute("href", "#actions-publish-later");
  });
});
