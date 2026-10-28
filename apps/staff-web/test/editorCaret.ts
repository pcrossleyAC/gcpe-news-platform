import type { TiptapEditorHTMLElement } from "@tiptap/core";

/**
 * Puts the caret at the end of a body editor's text (editor/BodyEditor.tsx), for a test that
 * then types with `{ skipClick: true }` and expects the text appended.
 *
 * Do not do this by moving the DOM selection (selectAllChildren/collapseToEnd, or user-event's
 * own caret move when `type` clicks first). ProseMirror only learns of a DOM selection change
 * from the `selectionchange` event, which jsdom fires from a setImmediate. Its focus handler also
 * arms a 20ms timer that, if the DOM selection differs from the last one it read, writes the
 * editor's own selection back into the DOM. On a slow runner, when the test resumes from a
 * setImmediate callback more than 20ms after the click focused the editor, that timer runs before
 * the queued `selectionchange`, and the caret snaps back to where ProseMirror last had it (the
 * start of the text): typing "yz" after "x" saved "<p>yzx</p>" on the Windows CI runner.
 *
 * Setting the selection through the editor updates ProseMirror's state and the DOM together, so
 * there is nothing for that timer to reconcile.
 */
export function caretToEnd(field: HTMLElement): void {
  const editor = (field as TiptapEditorHTMLElement).editor;
  if (!editor) throw new Error("caretToEnd: not a TipTap editing area");
  editor.commands.focus("end");
}
