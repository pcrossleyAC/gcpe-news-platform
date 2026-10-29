import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnsavedChangesBar } from "./UnsavedChangesBar";
import type { DirtySection } from "./useUnsavedChanges";

const save = async () => true;
const pageDetails: DirtySection = { key: "page-details", label: "Save page details", save };
const document1: DirtySection = { key: "document-doc-1-4105", label: "Save English content (Document 1)", save };
const settings: DirtySection = { key: "settings", label: "Save settings", save };

describe("UnsavedChangesBar", () => {
  afterEach(() => cleanup());

  it("renders nothing while no section is dirty", () => {
    const { container } = render(<UnsavedChangesBar sections={[]} state={{ status: "idle" }} onSave={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names every dirty section, with one Save changes button for all of them", () => {
    render(<UnsavedChangesBar sections={[pageDetails, document1]} state={{ status: "idle" }} onSave={() => {}} />);
    const region = screen.getByRole("region", { name: "Unsaved changes" });
    expect(region).toHaveTextContent("You have unsaved changes in: page details, English content (Document 1)");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("Save changes calls the page's one Save", async () => {
    const onSave = vi.fn();
    render(<UnsavedChangesBar sections={[pageDetails]} state={{ status: "idle" }} onSave={onSave} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("the button is busy (aria-disabled, never disabled) while saving", () => {
    render(<UnsavedChangesBar sections={[pageDetails]} state={{ status: "saving" }} onSave={() => {}} />);
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
  });

  it("when a section doesn't save, says which (linking to it) and which were not sent", () => {
    render(
      <UnsavedChangesBar
        sections={[pageDetails, settings]}
        state={{ status: "failed", failed: { key: "page-details", label: "Save page details" }, notSaved: [{ key: "settings", label: "Save settings" }] }}
        onSave={() => {}}
        targetOf={(key) => (key === "page-details" ? "section-page-details" : null)}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t save page details. See why in that section. Not saved yet: settings.");
    expect(screen.getByRole("link", { name: "See why in that section" })).toHaveAttribute("href", "#section-page-details");
  });

  it("after everything saved, says so briefly instead of disappearing at once", () => {
    render(<UnsavedChangesBar sections={[]} state={{ status: "saved" }} onSave={() => {}} />);
    expect(screen.getByRole("region", { name: "Save status" })).toHaveTextContent("All changes saved.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
