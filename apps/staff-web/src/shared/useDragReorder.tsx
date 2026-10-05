import { useState, type DragEvent } from "react";

/**
 * Drag-and-drop reorder state, shared by every reorderable row list (I3: DocumentsSection,
 * CarouselScreen's slides, LinksScreen) — previously each screen kept its own `dragIndex`
 * state plus `onDragStart`/`onDragOver`/`onDrop` and put all three on the *whole row*, which
 * made the row's own text inputs un-selectable with the mouse (grabbing text inside an
 * ancestor with `draggable` starts a drag instead of a text selection) and caused accidental
 * reorders from a stray mousedown-drag over a field.
 *
 * The fix splits the row in two: `dragHandleProps` goes only on a small grip element (see
 * {@link DragHandle}) — the one draggable thing in the row — and `dropZoneProps` goes on the
 * row itself, so dropping anywhere on the row still works.
 */
export interface UseDragReorderOptions {
  /** False while read-only or a save is in flight — matches the Move up/down buttons'
   * `isDisabled`. */
  enabled: boolean;
  onReorder(from: number, to: number): void;
}

export interface DragReorder {
  dragIndex: number | null;
  /** Spread onto the row's drag handle — the only element with `draggable`. */
  dragHandleProps(index: number): { draggable: boolean; onDragStart?: (e: DragEvent<Element>) => void };
  /** Spread onto the row/container so a drop anywhere on it reorders. */
  dropZoneProps(index: number): { onDragOver?: (e: DragEvent<Element>) => void; onDrop?: (e: DragEvent<Element>) => void };
}

export function useDragReorder({ enabled, onReorder }: UseDragReorderOptions): DragReorder {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const dragHandleProps = (index: number) => ({
    draggable: enabled,
    onDragStart: enabled
      ? (e: DragEvent<Element>) => {
          setDragIndex(index);
          e.dataTransfer.effectAllowed = "move";
        }
      : undefined,
  });

  const dropZoneProps = (index: number) => ({
    onDragOver: enabled ? (e: DragEvent<Element>) => e.preventDefault() : undefined,
    onDrop: enabled
      ? (e: DragEvent<Element>) => {
          e.preventDefault();
          if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
          setDragIndex(null);
        }
      : undefined,
  });

  return { dragIndex, dragHandleProps, dropZoneProps };
}

export interface DragHandleProps {
  reorder: DragReorder;
  index: number;
  /** e.g. "Drag to reorder slide 1" — the handle's only accessible content. */
  label: string;
}

/**
 * The small grip that's the only draggable part of a reorderable row. Not in the tab order
 * (`tabIndex={-1}`): dragging has no keyboard equivalent, so a keyboard user never lands here —
 * the row's own Move up/down buttons are the keyboard-operable alternative (constraints.md).
 */
export function DragHandle({ reorder, index, label }: DragHandleProps): React.JSX.Element {
  return (
    <span className="gcpe-drag-handle" role="img" aria-label={label} tabIndex={-1} {...reorder.dragHandleProps(index)}>
      ⠿
    </span>
  );
}
