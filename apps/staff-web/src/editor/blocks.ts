/**
 * Show blocks (legacy CKEditor's "Show Blocks", C323): outlines each top-level block of the body
 * and, while they show, lets the user move a block. A block moves by dragging its handle, or by
 * the toolbar's Move up / Move down (the keyboard and single-pointer way, as C45's lists have).
 * View-only: no node or mark, so the schema (schema.ts) and the HTML it produces are unchanged.
 */
import { Extension } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const showBlocksKey = new PluginKey<boolean>("showBlocks");

/** Whether blocks are showing. */
export const blocksShown = (state: EditorState): boolean => showBlocksKey.getState(state) ?? false;

/** Shows or hides the blocks. Not an edit: no update event, and nothing for undo. */
export function setBlocksShown(view: EditorView, shown: boolean): void {
  view.dispatch(view.state.tr.setMeta(showBlocksKey, shown).setMeta("addToHistory", false));
}

/** The index and start of the top-level block holding the selection, or null when it spans more
 * than one block. */
function selectedBlock(state: EditorState): { index: number; start: number } | null {
  const { doc, selection } = state;
  const index = doc.resolve(selection.from).index(0);
  // A selected block's `to` is just after it, at the next block's index.
  const end = selection instanceof NodeSelection ? selection.to - 1 : selection.to;
  if (index >= doc.childCount || doc.resolve(end).index(0) !== index) return null;
  let start = 0;
  for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
  return { index, start };
}

/** Moves the top-level block holding the selection one place up (-1) or down (1), keeping the
 * selection on it. False, and nothing done, when it is already first or last. */
export function moveBlock(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const block = selectedBlock(state);
    if (!block) return false;
    const { doc, selection } = state;
    const other = block.index + dir;
    if (other < 0 || other >= doc.childCount) return false;
    if (!dispatch) return true;
    const node = doc.child(block.index);
    const neighbour = doc.child(other);
    const from = dir < 0 ? block.start - neighbour.nodeSize : block.start;
    const to = dir < 0 ? block.start + node.nodeSize : block.start + node.nodeSize + neighbour.nodeSize;
    const shift = dir < 0 ? -neighbour.nodeSize : neighbour.nodeSize;
    const tr = state.tr.replaceWith(from, to, Fragment.from(dir < 0 ? [node, neighbour] : [neighbour, node]));
    tr.setSelection(
      selection instanceof NodeSelection
        ? NodeSelection.create(tr.doc, selection.from + shift)
        : TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift),
    );
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** A block's drag handle, in the gutter beside it. Hidden from assistive technology: Move up and
 * Move down are its accessible equivalent. */
function handle(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const el = document.createElement("span");
  el.className = "gcpe-body-editor__handle";
  el.draggable = true;
  el.contentEditable = "false";
  el.title = "Drag to move this block";
  el.setAttribute("aria-hidden", "true");
  el.addEventListener("dragstart", (event) => {
    const pos = getPos();
    if (pos === undefined || !event.dataTransfer) return;
    const selection = NodeSelection.create(view.state.doc, pos);
    view.dispatch(view.state.tr.setSelection(selection));
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", selection.node.textContent);
    // ProseMirror's own drop handler reads this: it removes the selected block and inserts it at
    // the drop point, as one undoable step.
    (view as unknown as { dragging: { slice: unknown; move: boolean; node: NodeSelection } }).dragging = { slice: selection.content(), move: true, node: selection };
  });
  return el;
}

export const ShowBlocks = Extension.create({
  name: "showBlocks",
  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: showBlocksKey,
        state: {
          init: () => false,
          apply: (tr, shown) => (tr.getMeta(showBlocksKey) as boolean | undefined) ?? shown,
        },
        props: {
          attributes: (state): Record<string, string> => (blocksShown(state) ? { class: "gcpe-body-editor--blocks" } : {}),
          decorations: (state) => {
            if (!blocksShown(state) || !this.editor.isEditable) return DecorationSet.empty;
            const handles: Decoration[] = [];
            state.doc.forEach((_node, offset, index) => {
              handles.push(
                Decoration.widget(offset, handle, {
                  key: `handle-${index}`,
                  side: -1,
                  // The handle starts its own drag; ProseMirror would otherwise start one from the selection.
                  stopEvent: (event) => event.type === "dragstart" || event.type === "mousedown",
                  ignoreSelection: true,
                }),
              );
            });
            return DecorationSet.create(state.doc, handles);
          },
        },
      }),
    ];
  },
});
