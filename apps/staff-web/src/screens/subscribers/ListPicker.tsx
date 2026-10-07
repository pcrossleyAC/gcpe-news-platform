import type { ListOptions } from "./types";

/** "All news" or individual lists by category (legacy AddEditSubscriber's "All news" /
 * "Customize"). `heldKeys` are lists the subscriber already has that the options no longer
 * offer (an inactive list): shown, ticked, and kept unless unticked — the server accepts them
 * for this subscriber only. Media lists are never shown here. */
export function ListPicker(props: {
  categories: ListOptions["categories"];
  allNews: boolean;
  listKeys: string[];
  heldKeys?: string[];
  onChange(next: { allNews: boolean; listKeys: string[] }): void;
  disabled?: boolean;
}): React.JSX.Element {
  const { categories, allNews, listKeys, onChange, disabled } = props;
  const offered = new Set(categories.flatMap((c) => c.lists.map((l) => l.listKey)));
  const extra = (props.heldKeys ?? []).filter((k) => !offered.has(k));
  const toggle = (k: string) => onChange({ allNews, listKeys: listKeys.includes(k) ? listKeys.filter((x) => x !== k) : [...listKeys, k] });
  const box = (k: string, label: string) => (
    <label key={k}>
      <input type="checkbox" checked={listKeys.includes(k)} onChange={() => toggle(k)} disabled={disabled} /> {label}
    </label>
  );
  return (
    <fieldset>
      <legend>Lists</legend>
      <label>
        <input type="checkbox" checked={allNews} onChange={() => onChange({ allNews: !allNews, listKeys })} disabled={disabled} /> All news
      </label>
      {!allNews &&
        categories.map((c) => (
          <fieldset key={c.key}>
            <legend>{c.name}</legend>
            {c.lists.map((l) => box(l.listKey, l.name))}
          </fieldset>
        ))}
      {!allNews && extra.length > 0 && (
        <fieldset>
          <legend>No longer offered</legend>
          {extra.map((k) => box(k, k))}
        </fieldset>
      )}
    </fieldset>
  );
}
