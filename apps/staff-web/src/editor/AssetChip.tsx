import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import type { AssetAttrs } from "./schema";

/** The `<asset>` embed's node view (task-4-brief.md: "rendered as a non-editable embed chip
 * showing its URL") — `contentEditable={false}` so nothing can type inside it; the atom node
 * itself (schema.ts's `Asset`) carries no editable content at all. */
export function AssetChip({ node }: NodeViewProps): React.JSX.Element {
  const { url } = node.attrs as AssetAttrs;
  return (
    <NodeViewWrapper className="gcpe-body-editor__asset-chip" contentEditable={false} data-drag-handle>
      <span className="gcpe-body-editor__asset-chip-label">Embedded asset</span>
      <span className="gcpe-body-editor__asset-chip-url">{url || "(no URL)"}</span>
    </NodeViewWrapper>
  );
}
