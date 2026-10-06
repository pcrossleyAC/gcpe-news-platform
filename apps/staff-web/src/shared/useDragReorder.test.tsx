import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DragHandle, useDragReorder } from "./useDragReorder";

/** A minimal 3-row list driven entirely by the hook, standing in for
 * DocumentsSection/CarouselScreen/LinksScreen's own rows (I3). */
function List({ enabled, onReorder }: { enabled: boolean; onReorder: (from: number, to: number) => void }) {
  const reorder = useDragReorder({ enabled, onReorder });
  return (
    <div>
      {["Row 1", "Row 2", "Row 3"].map((text, index) => (
        <div key={text} data-testid={`row-${index}`} className="row" {...reorder.dropZoneProps(index)}>
          <DragHandle reorder={reorder} index={index} label={`Drag to reorder ${text}`} />
          <input aria-label={`${text} text`} defaultValue={text} />
        </div>
      ))}
    </div>
  );
}

describe("useDragReorder / DragHandle (I3)", () => {
  afterEach(cleanup);

  it("only the handle is draggable — the row and its inputs are not", () => {
    render(<List enabled onReorder={() => {}} />);
    const handle = screen.getByRole("img", { name: "Drag to reorder Row 1" });
    expect(handle).toHaveAttribute("draggable", "true");

    const row = screen.getByTestId("row-0");
    expect(row).not.toHaveAttribute("draggable");
    const input = screen.getByLabelText("Row 1 text");
    expect(input).not.toHaveAttribute("draggable");
    expect(input.closest("[draggable='true']")).toBeNull();
  });

  it("dragstart on the handle, then drop on another row's drop zone, reorders by index", () => {
    const onReorder = vi.fn();
    render(<List enabled onReorder={onReorder} />);

    const handle = screen.getByRole("img", { name: "Drag to reorder Row 1" });
    const dataTransfer = { effectAllowed: "" };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.drop(screen.getByTestId("row-2"), { dataTransfer });

    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("dropping on the same row that started the drag is a no-op", () => {
    const onReorder = vi.fn();
    render(<List enabled onReorder={onReorder} />);
    const handle = screen.getByRole("img", { name: "Drag to reorder Row 1" });
    const dataTransfer = { effectAllowed: "" };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.drop(screen.getByTestId("row-0"), { dataTransfer });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("disabled (e.g. read-only or saving): the handle isn't draggable and drop does nothing", () => {
    const onReorder = vi.fn();
    render(<List enabled={false} onReorder={onReorder} />);
    const handle = screen.getByRole("img", { name: "Drag to reorder Row 1" });
    expect(handle).toHaveAttribute("draggable", "false");

    const dataTransfer = { effectAllowed: "" };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.drop(screen.getByTestId("row-2"), { dataTransfer });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("the handle is not in the tab order (dragging has no keyboard equivalent; use Move up/down)", () => {
    render(<List enabled onReorder={() => {}} />);
    expect(screen.getByRole("img", { name: "Drag to reorder Row 1" })).toHaveAttribute("tabindex", "-1");
  });
});
