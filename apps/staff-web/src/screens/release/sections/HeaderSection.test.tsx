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

  it("shows the approve checklist when approveProblems is non-empty, and hides it when empty", () => {
    const { rerender } = render(<HeaderSection view={releaseView({ type: "release", ministries: [] })} />);
    const heading = screen.getByText("Before this can be approved:");
    expect(heading).toBeInTheDocument();
    expect(heading.nextElementSibling).toHaveTextContent("Choose at least one ministry.");

    rerender(<HeaderSection view={releaseView({ type: "release", ministries: ["health"], leadMinistryKey: "health" })} />);
    expect(screen.queryByText("Before this can be approved:")).not.toBeInTheDocument();
  });

  it("shows the publish checklist when publishProblems is non-empty", () => {
    render(<HeaderSection view={releaseView({ documents: [] })} />);
    const heading = screen.getByText("Before this can be published:");
    expect(heading).toBeInTheDocument();
    expect(heading.nextElementSibling).toHaveTextContent("Add at least one document.");
  });
});
