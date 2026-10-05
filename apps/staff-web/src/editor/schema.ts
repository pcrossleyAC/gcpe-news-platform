/**
 * The release body editor's TipTap schema (task-4-brief.md): one node/mark per entry in the
 * shared, zod-only `@gcpe/nrms-contract` allow-list (`BODY_TAGS`/`BODY_ATTRIBUTES`/
 * `BODY_SCHEMES`, packages/nrms-contract/src/html.ts) — paragraph, bulleted/numbered list, list
 * item, bold (rendered as `<strong>`), hard break, a link whose `href` is limited to
 * `BODY_SCHEMES`, a plain `<div>` block, and the `<asset>` embed (a non-editable chip; see
 * {@link Asset}). Every other TipTap extension (headings, italics, code, blockquote, images,
 * underline, strike, …) is simply never listed here — there is nothing to "disable".
 *
 * Pure `@tiptap/core`/extension-package code, no React and no DOM-only globals at the type
 * level — so this module can be imported both by the real browser editor
 * (apps/staff-web/src/editor/BodyEditor.tsx) and by a Node-environment test
 * (apps/nrms/test/text/editor-roundtrip.test.ts) that round-trips this schema's own HTML output
 * through the real server sanitiser (apps/nrms/src/text/sanitize.ts) — see that test file for
 * why it lives under apps/nrms/test rather than apps/staff-web/src.
 */
import { mergeAttributes, Node, type AnyExtension } from "@tiptap/core";
import { BODY_SCHEMES } from "@gcpe/nrms-contract";
import DocumentExt from "@tiptap/extension-document";
import TextExt from "@tiptap/extension-text";
import Paragraph from "@tiptap/extension-paragraph";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import OrderedList from "@tiptap/extension-ordered-list";
import ListItem from "@tiptap/extension-list-item";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import History from "@tiptap/extension-history";

/** A plain `<div>` block — the allow-list's one generic container, with no semantics of its
 * own. Content model is inline (text/hard-break/link/bold), matching the legacy/server
 * sanitiser's own treatment of a bare `<div>` (apps/nrms/src/text/sanitize.test.ts: a `<div>`
 * holding text and a `<br>` directly, never auto-wrapped in a `<p>`). */
export const Div = Node.create({
  name: "div",
  group: "block",
  content: "inline*",
  parseHTML() {
    return [{ tag: "div" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), 0];
  },
});

export interface AssetAttrs {
  url: string;
}

/**
 * The `<asset>` embed (spec addendum §4 / apps/nrms/src/media/embeds.ts): a bare URL as the
 * node's whole text content, e.g. `<asset>https://youtu.be/abc</asset>`. Modelled as an atom
 * block (no editable content of its own — the URL lives in the `url` attribute, read from and
 * written back as the tag's text) so the editor can never let a user type inside it; the real
 * browser editor (BodyEditor.tsx) layers a non-editable chip node view on top of this via
 * `Asset.extend({ addNodeView() {...} })`, which this module itself can't depend on (no React
 * here — see the file header).
 */
export const Asset = Node.create<Record<string, never>, AssetAttrs>({
  name: "asset",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "asset" }];
  },
  renderHTML({ node }) {
    return ["asset", {}, (node.attrs as AssetAttrs).url];
  },
});

/**
 * Builds a fresh extension list every call (TipTap/ProseMirror extensions carry per-editor
 * state, so each `useEditor`/`generateHTML` call gets its own instances). `assetExtension`
 * lets the real browser editor swap in a node-view-carrying variant of {@link Asset} while
 * every other extension, and the schema it produces, stays identical to what this test suite
 * (and the Node round-trip test) exercises.
 */
export function bodyExtensions(assetExtension: AnyExtension = Asset): AnyExtension[] {
  return [
    DocumentExt,
    TextExt,
    Paragraph,
    Bold,
    BulletList,
    OrderedList,
    ListItem,
    HardBreak,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: true,
      protocols: [...BODY_SCHEMES],
      HTMLAttributes: { target: null, rel: null, class: null },
    }),
    History,
    Div,
    assetExtension,
  ];
}
