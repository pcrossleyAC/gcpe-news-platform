import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "./BusyButton";

describe("BusyButton Button", () => {
  afterEach(cleanup);

  it("shows the normal label while idle", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("shows pendingLabel instead of children while pending", () => {
    render(
      <Button isPending pendingLabel="Saving…">
        Save
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("leaves children unchanged while pending when no pendingLabel is given", () => {
    render(<Button isPending>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("passes aria-label through untouched, idle or pending", () => {
    render(<Button aria-label="Remove file">×</Button>);
    expect(screen.getByRole("button", { name: "Remove file" })).toBeInTheDocument();
    cleanup();

    render(
      <Button isPending pendingLabel="Removing…" aria-label="Remove file">
        ×
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Remove file" })).toHaveAttribute("aria-label", "Remove file");
  });
});
