import { useEffect } from "react";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState } from "@tiptap/react";
import { Button, ToggleButton } from "@bcgov/design-system-react-components";
import { Asset, bodyExtensions } from "./schema";
import { AssetChip } from "./AssetChip";
import { reduceToAllowedHtml } from "./pasteFilter";
import { BIO_TAGS, BODY_TAGS } from "@gcpe/nrms-contract";

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
  /** Allow `<asset>` embeds: the Insert asset button, the asset node and pasted `<asset>`s. Default
   * true; the minister biography turns it off, so a stored or pasted `<asset>` shows as its URL
   * text, which is what Core stores. Read once, when the editor is created. */
  allowAssets?: boolean;
  /** Italic: the toolbar toggle, the mark, and `em` in the paste allow-list. Default false: only the
   * settings editors turn it on, because their server allow-list keeps `<em>`; the release body and
   * the biography drop it. Read once, when the editor is created. */
  allowItalic?: boolean;
  /** Space-separated ids of the hint, note or error that describe the editing area. */
  describedBy?: string;
}

/**
 * The release body editor (task-4-brief.md): TipTap, limited to schema.ts's allow-listed
 * nodes/marks, with a toolbar for the actions that schema exposes (bold, bulleted/numbered
 * list, link, inserting an `<asset>` embed). Paste is reduced to the same allow-list
 * client-side (pasteFilter.ts) before ProseMirror ever parses it, matching what the server
 * sanitiser would keep.
 */
export function BodyEditor({ id, label, value, onChange, readOnly, allowAssets = true, allowItalic = false, describedBy }: BodyEditorProps): React.JSX.Element {
  const attributes = (): Record<string, string> => ({
    id,
    role: "textbox",
    "aria-multiline": "true",
    "aria-labelledby": `${id}-label`,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
  });
  // useEditor(…, []) creates the editor once but re-applies these options after every render
  // (@tiptap/react's setOptions on render), so a description that comes and goes (a note, a
  // server error) reaches the editing area's attributes without an effect of its own.
  const editor = useEditor(
    {
      extensions: bodyExtensions(allowAssets ? AssetWithView : null, { italic: allowItalic }),
      content: value,
      editable: !readOnly,
      editorProps: {
        attributes: attributes(),
        transformPastedHTML: (pasted: string) => reduceToAllowedHtml(pasted, (allowAssets ? BODY_TAGS : BIO_TAGS).filter((t) => allowItalic || t !== "em")),
      },
      onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    },
    [],
  );

  // The toolbar's pressed states follow the caret (WCAG 4.1.2): useEditor does not re-render on
  // selection changes, so the active marks are subscribed to here.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive("bold"),
      italic: !!e?.isActive("italic"),
      bullet: !!e?.isActive("bulletList"),
      ordered: !!e?.isActive("orderedList"),
      link: !!e?.isActive("link"),
    }),
  });

  // Not a content change, so no update event: TipTap's default would call onChange on mount with
  // its own rewrite of `value` (<b> as <strong>, line breaks dropped), which reads as an edit.
  useEffect(() => {
    editor?.setEditable(!readOnly, false);
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
      <span id={`${id}-label`} className="gcpe-body-editor__label">
        {label}
      </span>
      {!readOnly && editor && (
        <div className="gcpe-body-editor__toolbar" role="toolbar" aria-label={`${label} formatting`}>
          {/* One visual group of formatting toggles (the design system's toggle-group look);
           * Insert asset, an action rather than a format, sits apart as a secondary button. */}
          <div className="gcpe-body-editor__toggles">
            <ToggleButton size="small" isSelected={active.bold} onChange={() => editor.chain().focus().toggleBold().run()}>
              Bold
            </ToggleButton>
            {allowItalic && (
              <ToggleButton size="small" isSelected={active.italic} onChange={() => editor.chain().focus().toggleItalic().run()}>
                Italic
              </ToggleButton>
            )}
            <ToggleButton size="small" isSelected={active.bullet} onChange={() => editor.chain().focus().toggleBulletList().run()}>
              Bulleted list
            </ToggleButton>
            <ToggleButton size="small" isSelected={active.ordered} onChange={() => editor.chain().focus().toggleOrderedList().run()}>
              Numbered list
            </ToggleButton>
            <ToggleButton size="small" isSelected={active.link} onChange={toggleLink}>
              Link
            </ToggleButton>
          </div>
          {allowAssets && (
            <Button size="small" variant="secondary" onPress={insertAsset}>
              Insert asset
            </Button>
          )}
        </div>
      )}
      <EditorContent editor={editor} className="gcpe-body-editor__area" />
    </div>
  );
}
