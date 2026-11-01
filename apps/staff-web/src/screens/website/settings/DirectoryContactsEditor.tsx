import { useEffect, useRef } from "react";
import { Radio, RadioGroup, TextField } from "@bcgov/design-system-react-components";
import type { DirectoryContact, FieldError } from "@gcpe/site-settings";
import { useAnnouncer } from "../../../shared/Announcer";
import { Button } from "../../../shared/BusyButton";
import { useMoveFocusRestore } from "../../../shared/useMoveFocusRestore";
import { moveItemBy } from "../reorder";

const BLANK: DirectoryContact = { group: "", groupUrl: "", subgroup: "", name: "", phone: "", cell: "", email: "", placement: "top" };

/** A row the editor left completely blank (ignoring the Placement choice) — dropped before sending. */
const isBlank = (c: DirectoryContact) => [c.group, c.groupUrl, c.subgroup, c.name, c.phone, c.cell, c.email].every((v) => v.trim() === "");
export const withoutBlankContacts = (contacts: DirectoryContact[]): DirectoryContact[] => contacts.filter((c) => !isBlank(c));

export interface DirectoryContactsEditorProps {
  value: DirectoryContact[];
  onChange(next: DirectoryContact[]): void;
  /** Field errors from the server; only those under `pathPrefix` are shown, on their row by index. */
  errors: FieldError[];
  /** The list's field path, e.g. `"contactsPage.contacts"`, so `contactsPage.contacts[1].email` lands on row 2's Email. */
  pathPrefix: string;
  disabled?: boolean;
}

type TextKey = "group" | "groupUrl" | "subgroup" | "name" | "phone" | "cell" | "email";
export const FIELDS: { key: TextKey; label: string; type?: "tel" | "email"; description?: string }[] = [
  { key: "group", label: "Group" },
  { key: "groupUrl", label: "Group link", description: "Optional. A page on this site, like /ministries/health/, or a full web address starting with https://." },
  { key: "subgroup", label: "Subgroup" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "cell", label: "Cell", type: "tel" },
  { key: "email", label: "Email", type: "email" },
];
/** `[1].email` (a field on row 2) or `[1]` (row 2 as a whole, kept under the key ""). */
const ROW_ERROR = /^\[(\d+)\](?:\.(\w+))?$/;

/**
 * The editable list of other media contacts (Media contacts page). One boxed row each, with
 * Move up/down and Remove; "Add contact" appends a blank row that shows above the ministries.
 * Same focus and announcement behaviour as LinkListEditor.
 */
export function DirectoryContactsEditor({ value, onChange, errors, pathPrefix, disabled = false }: DirectoryContactsEditorProps): React.JSX.Element {
  const { announce } = useAnnouncer();
  const moveFocus = useMoveFocusRestore<HTMLFieldSetElement>();
  const addRef = useRef<HTMLSpanElement>(null);
  const pendingFocus = useRef<string | "add" | null>(null);

  const keys = useRef<string[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < value.length) keys.current.push(`contact-${nextKey.current++}`);
  if (keys.current.length > value.length) keys.current.length = value.length;

  useEffect(() => {
    moveFocus.restore();
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "add") addRef.current?.querySelector("button")?.focus();
    else if (target) moveFocus.containerRef.current?.querySelector<HTMLInputElement>(`[data-row-key="${target}"] input`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
  const shown = new Set<string>([...FIELDS.map((f) => f.key), "placement"]);
  const fieldError = (index: number, name: string) => {
    const message = rowErrors.get(index)?.get(name);
    return { errorMessage: message, isInvalid: message !== undefined };
  };

  const update = (index: number, patch: Partial<DirectoryContact>) => onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const move = (index: number, delta: 1 | -1) => {
    moveFocus.remember(keys.current[index]!, delta === -1 ? "up" : "down");
    announce(`Contact ${index + 1} moved to position ${index + 1 + delta}`);
    keys.current = moveItemBy(keys.current, index, delta);
    onChange(moveItemBy(value, index, delta));
  };
  const remove = (index: number) => {
    pendingFocus.current = keys.current[index + 1] ?? "add";
    keys.current = keys.current.filter((_, i) => i !== index);
    onChange(value.filter((_, i) => i !== index));
  };
  const add = () => {
    const key = `contact-${nextKey.current++}`;
    keys.current = [...keys.current, key];
    pendingFocus.current = key;
    onChange([...value, { ...BLANK }]);
  };

  return (
    <fieldset className="gcpe-link-list" ref={moveFocus.containerRef}>
      <legend>Other media contacts</legend>
      <p>Ministry contacts come from each ministry&rsquo;s Organizations form.</p>
      {value.length === 0 && <p>No other contacts yet.</p>}
      {value.map((contact, index) => {
        const key = keys.current[index]!;
        const others = [...(rowErrors.get(index) ?? [])].filter(([name]) => !shown.has(name));
        return (
          <fieldset key={key} data-row-key={key} className="gcpe-link-list__row">
            <legend>{`Contact ${index + 1}`}</legend>
            {FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                description={f.description}
                type={f.type}
                value={contact[f.key]}
                onChange={(v) => update(index, { [f.key]: v })}
                isDisabled={disabled}
                {...fieldError(index, f.key)}
              />
            ))}
            <RadioGroup
              label="Placement"
              value={contact.placement}
              onChange={(p) => update(index, { placement: p as DirectoryContact["placement"] })}
              isDisabled={disabled}
              {...fieldError(index, "placement")}
            >
              <Radio value="top">Above the ministries</Radio>
              <Radio value="bottom">Below the ministries</Radio>
            </RadioGroup>
            {others.map(([name, message]) => (
              <p key={name || "row"} className="gcpe-link-list__error">
                {message}
              </p>
            ))}
            {!disabled && (
              <div className="gcpe-link-list__actions">
                <span data-move-id={key} data-move-dir="up">
                  <Button variant="secondary" onPress={() => move(index, -1)} isDisabled={index === 0}>
                    {`Move contact ${index + 1} up`}
                  </Button>
                </span>
                <span data-move-id={key} data-move-dir="down">
                  <Button variant="secondary" onPress={() => move(index, 1)} isDisabled={index === value.length - 1}>
                    {`Move contact ${index + 1} down`}
                  </Button>
                </span>
                <Button variant="secondary" danger onPress={() => remove(index)}>
                  {`Remove contact ${index + 1}`}
                </Button>
              </div>
            )}
          </fieldset>
        );
      })}
      {!disabled && (
        <span ref={addRef}>
          <Button variant="secondary" onPress={add}>
            Add contact
          </Button>
        </span>
      )}
    </fieldset>
  );
}
