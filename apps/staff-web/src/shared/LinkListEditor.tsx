import { useEffect, useId, useRef } from "react";
import { TextField } from "@bcgov/design-system-react-components";
import type { FieldError, LinkSetting } from "@gcpe/site-settings";
import { moveItemBy } from "../screens/website/reorder";
import { useAnnouncer } from "./Announcer";
import { Button } from "./BusyButton";
import { useMoveFocusRestore } from "./useMoveFocusRestore";
import { HostWarning } from "./HostWarning";
import { useStaffHostWarning } from "./publicAddress";

/** A row the editor left completely blank — dropped before sending, as news.gov does. */
const isBlank = (link: LinkSetting) => [link.text, link.url, link.summary ?? ""].every((v) => v.trim() === "");

export function withoutBlankLinks(links: LinkSetting[]): LinkSetting[] {
  return links.filter((link) => !isBlank(link));
}

export interface LinkListEditorProps {
  legend: string;
  /** A sentence under the legend saying where the links appear; it describes the whole group. */
  description?: string;
  links: LinkSetting[];
  onChange(links: LinkSetting[]): void;
  /** Field errors from the server; only those under `pathPrefix` are shown, on their row by index. */
  errors: FieldError[];
  /** The list's field path, e.g. `"footer.helpLinks"`, so `footer.helpLinks[2].url` lands on row 3's Web address. */
  pathPrefix: string;
  reorderable: boolean;
  /** Show each link's Description (optional) — `summary`. */
  withSummary: boolean;
  isDisabled?: boolean;
  /** The most links the list may hold: "+ Add a link" is disabled at the limit, with a hint saying so. */
  maxLinks?: number;
}

type Shown = "text" | "url" | "summary";
/** `[2].url` (a field on row 3) or `[2]` (row 3 as a whole, kept under the key ""). */
const ROW_ERROR = /^\[(\d+)\](?:\.(\w+))?$/;

/**
 * An editable list of links (site settings' banner, footer and social lists; the Organizations
 * form's side-column links). Every row keeps the fields it doesn't show — `id` (kept for
 * analytics) and, without `withSummary`, `summary` — through edits and moves unchanged.
 * Move up/down follows LinksScreen's pattern (moveItemBy, focus kept on the moved link's own
 * button, an announcement); adding a row focuses its Link text, removing one focuses the next
 * row (or "+ Add a link").
 */
export function LinkListEditor({ legend, description, links, onChange, errors, pathPrefix, reorderable, withSummary, isDisabled = false, maxLinks }: LinkListEditorProps): React.JSX.Element {
  const { announce } = useAnnouncer();
  const descriptionId = useId();
  const limitId = useId();
  const warningId = useId();
  const atLimit = maxLinks !== undefined && links.length >= maxLinks;
  const moveFocus = useMoveFocusRestore<HTMLFieldSetElement>();
  const addRef = useRef<HTMLSpanElement>(null);
  const pendingFocus = useRef<string | "add" | null>(null);
  // W1: an address pasted from the Hub's own (internal) host works for staff but not the public.
  const staffHostWarning = useStaffHostWarning();

  // Each row's stable key (React identity and focus targets), parallel to `links` and permuted
  // with it by every action below; a list replaced from outside (a reload) just keeps its keys.
  const keys = useRef<string[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < links.length) keys.current.push(`link-${nextKey.current++}`);
  if (keys.current.length > links.length) keys.current.length = links.length;

  useEffect(() => {
    moveFocus.restore();
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "add") addRef.current?.querySelector("button")?.focus();
    else if (target) moveFocus.containerRef.current?.querySelector<HTMLInputElement>(`[data-row-key="${target}"] input`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links]);

  const rowErrors = new Map<number, Map<string, string>>();
  for (const e of errors) {
    if (!e.field.startsWith(`${pathPrefix}[`)) continue;
    const m = ROW_ERROR.exec(e.field.slice(pathPrefix.length));
    if (!m) continue;
    const row = rowErrors.get(Number(m[1])) ?? new Map<string, string>();
    const name = m[2] ?? "";
    if (!row.has(name)) row.set(name, e.message);
    rowErrors.set(Number(m[1]), row);
  }
  const shown: Shown[] = withSummary ? ["text", "url", "summary"] : ["text", "url"];
  // A problem with the list itself (`<pathPrefix>`, e.g. too many links) shows under its legend.
  const listErrors = [...new Set(errors.filter((e) => e.field === pathPrefix).map((e) => e.message))];

  const update = (index: number, patch: Partial<LinkSetting>) => onChange(links.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  const updateSummary = (index: number, summary: string) =>
    onChange(
      links.map((link, i) => {
        if (i !== index) return link;
        const { summary: _old, ...rest } = link;
        return summary === "" ? rest : { ...rest, summary };
      }),
    );
  const move = (index: number, delta: 1 | -1) => {
    moveFocus.remember(keys.current[index]!, delta === -1 ? "up" : "down");
    announce(`Link ${index + 1} moved to position ${index + 1 + delta}`);
    keys.current = moveItemBy(keys.current, index, delta);
    onChange(moveItemBy(links, index, delta));
  };
  const remove = (index: number) => {
    pendingFocus.current = keys.current[index + 1] ?? "add";
    keys.current = keys.current.filter((_, i) => i !== index);
    onChange(links.filter((_, i) => i !== index));
  };
  const add = () => {
    const key = `link-${nextKey.current++}`;
    keys.current = [...keys.current, key];
    pendingFocus.current = key;
    onChange([...links, { text: "", url: "" }]);
  };

  const fieldError = (index: number, name: Shown) => {
    const message = rowErrors.get(index)?.get(name);
    return { errorMessage: message, isInvalid: message !== undefined };
  };

  return (
    <fieldset className="gcpe-link-list" ref={moveFocus.containerRef} aria-describedby={description === undefined ? undefined : descriptionId}>
      <legend>{legend}</legend>
      {description !== undefined && <p id={descriptionId}>{description}</p>}
      {listErrors.map((message) => (
        <p key={message} role="alert" className="gcpe-link-list__error">
          {message}
        </p>
      ))}
      {links.length === 0 && <p>No links yet.</p>}
      {links.map((link, index) => {
        const key = keys.current[index]!;
        const others = [...(rowErrors.get(index) ?? [])].filter(([name]) => !shown.includes(name as Shown));
        const hostWarning = staffHostWarning(link.url);
        return (
          <fieldset key={key} data-row-key={key} className="gcpe-link-list__row">
            <legend>{`Link ${index + 1}`}</legend>
            <TextField label="Link text" value={link.text} onChange={(v) => update(index, { text: v })} isDisabled={isDisabled} {...fieldError(index, "text")} />
            <TextField
              label="Web address"
              value={link.url}
              onChange={(v) => update(index, { url: v })}
              isDisabled={isDisabled}
              aria-describedby={hostWarning ? `${warningId}-${key}` : undefined}
              {...fieldError(index, "url")}
            />
            <HostWarning id={`${warningId}-${key}`} text={hostWarning} />
            {withSummary && (
              <TextField label="Description (optional)" value={link.summary ?? ""} onChange={(v) => updateSummary(index, v)} isDisabled={isDisabled} {...fieldError(index, "summary")} />
            )}
            {others.map(([name, message]) => (
              <p key={name || "row"} className="gcpe-link-list__error">
                {message}
              </p>
            ))}
            {!isDisabled && (
              <div className="gcpe-link-list__actions">
                {reorderable && (
                  <>
                    <span data-move-id={key} data-move-dir="up">
                      <Button variant="secondary" onPress={() => move(index, -1)} isDisabled={index === 0}>
                        {`Move link ${index + 1} up`}
                      </Button>
                    </span>
                    <span data-move-id={key} data-move-dir="down">
                      <Button variant="secondary" onPress={() => move(index, 1)} isDisabled={index === links.length - 1}>
                        {`Move link ${index + 1} down`}
                      </Button>
                    </span>
                  </>
                )}
                <Button variant="secondary" danger onPress={() => remove(index)}>
                  {`Remove link ${index + 1}`}
                </Button>
              </div>
            )}
          </fieldset>
        );
      })}
      {!isDisabled && (
        <span ref={addRef}>
          <Button variant="secondary" onPress={add} isDisabled={atLimit} aria-describedby={atLimit ? limitId : undefined}>
            + Add a link
          </Button>
          {atLimit && <p id={limitId}>{`You can have at most ${maxLinks} ${maxLinks === 1 ? "link" : "links"}.`}</p>}
        </span>
      )}
    </fieldset>
  );
}
