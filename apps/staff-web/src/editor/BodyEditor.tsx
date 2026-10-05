import { useEffect } from "react";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { Button, ToggleButton } from "@bcgov/design-system-react-components";
import { Asset, bodyExtensions } from "./schema";
import { AssetChip } from "./AssetChip";
import { reduceToAllowedHtml } from "./pasteFilter";

/** The browser-only variant of the `<asset>` node — same schema as {@link Asset}, plus the
 * interactive chip node view (AssetChip.tsx), which schema.ts itself can't depend on (no React
 * there — see its file header). */
const AssetWithView = Asset.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AssetChip);
  },
});

export interface BodyEditorProps {
  id: string;
  label: string;
  value: string;
  onChange(html: string): void;
  readOnly: boolean;
}

/**
 * The release body editor (task-4-brief.md): TipTap, limited to schema.ts's allow-listed
 * nodes/marks, with a toolbar for the actions that schema exposes (bold, bulleted/numbered
 * list, link, inserting an `<asset>` embed). Paste is reduced to the same allow-list
 * client-side (pasteFilter.ts) before ProseMirror ever parses it, matching what the server
 * sanitiser would keep.
 */
export function BodyEditor({ id, label, value, onChange, readOnly }: BodyEditorProps): React.JSX.Element {
  const editor = useEditor(
    {
      extensions: bodyExtensions(AssetWithView),
      content: value,
      editable: !readOnly,
      editorProps: {
        attributes: { id, "aria-label": label },
        transformPastedHTML: (pasted: string) => reduceToAllowedHtml(pasted),
      },
      onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Resyncs when `value` changes from outside (a reload after a 409, or the session-expiry
  // restore) — never while the user is actively focused in the editor, so an external replace
  // (e.g. the whole page's `view` being swapped by an unrelated section's save) can't clobber
  // what they're mid-typing.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  const insertAsset = () => {
    if (!editor) return;
    const url = window.prompt("Asset URL (e.g. a YouTube link)");
    if (!url) return;
    editor.chain().focus().insertContent({ type: "asset", attrs: { url } }).run();
  };

  const toggleLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const url = window.prompt("Link URL (http://, https:// or mailto:)");
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="gcpe-body-editor">
      {!readOnly && editor && (
        <div className="gcpe-body-editor__toolbar" role="toolbar" aria-label={`${label} formatting`}>
          <ToggleButton isSelected={editor.isActive("bold")} onChange={() => editor.chain().focus().toggleBold().run()}>
            Bold
          </ToggleButton>
          <ToggleButton isSelected={editor.isActive("bulletList")} onChange={() => editor.chain().focus().toggleBulletList().run()}>
            Bulleted list
          </ToggleButton>
          <ToggleButton isSelected={editor.isActive("orderedList")} onChange={() => editor.chain().focus().toggleOrderedList().run()}>
            Numbered list
          </ToggleButton>
          <ToggleButton isSelected={editor.isActive("link")} onChange={toggleLink}>
            Link
          </ToggleButton>
          <Button onPress={insertAsset}>Insert asset</Button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
