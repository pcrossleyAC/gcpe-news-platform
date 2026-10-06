import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnsavedChangesBar } from "./UnsavedChangesBar";
import type { DirtySection } from "./useUnsavedChanges";

describe("UnsavedChangesBar", () => {
  afterEach(() => cleanup());

  it("renders nothing while no section is dirty", () => {
    const { container } = render(<UnsavedChangesBar sections={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names every dirty section in the region, with one Save button per section", () => {
    const sections: DirtySection[] = [
      { key: "page-details", label: "Save page details", save: () => {} },
      { key: "document-doc-1-4105", label: "Save English content (Document 1)", save: () => {} },
    ];
    render(<UnsavedChangesBar sections={sections} />);
    const region = screen.getByRole("region", { name: "Unsaved changes" });
    expect(region).toHaveTextContent("You have unsaved changes in: page details, English content (Document 1)");
    expect(screen.getByRole("button", { name: "Save page details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save English content (Document 1)" })).toBeInTheDocument();
  });

  it("clicking a section's button calls that section's own save — not a duplicate request", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<UnsavedChangesBar sections={[{ key: "page-details", label: "Save page details", save }]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save page details" }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("disables that section's button while its save is in flight, then re-enables once it settles", async () => {
    let resolveSave: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (resolveSave = resolve)));
    render(<UnsavedChangesBar sections={[{ key: "page-details", label: "Save page details", save }]} />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Save page details" });
    await user.click(button);
    expect(button).toBeDisabled();
    resolveSave();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("a section that drops out of `sections` (because it saved and is clean again) loses its button", () => {
    const { rerender } = render(<UnsavedChangesBar sections={[{ key: "page-details", label: "Save page details", save: () => {} }]} />);
    expect(screen.getByRole("button", { name: "Save page details" })).toBeInTheDocument();
    rerender(<UnsavedChangesBar sections={[]} />);
    expect(screen.queryByRole("button", { name: "Save page details" })).not.toBeInTheDocument();
  });
});
