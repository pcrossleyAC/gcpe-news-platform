import { useState } from "react";
import type { Choice } from "./form";

interface Common {
  id: string;
  label: string;
  error?: string[];
  /** HQ's needs-review markup (spec addendum §8.2 "Markup"). */
  review?: boolean;
  hint?: string;
  required?: boolean;
}

function describedBy(id: string, p: Pick<Common, "error" | "review" | "hint">): string | undefined {
  const ids = [p.review && `${id}-review`, p.hint && `${id}-hint`, p.error?.length && `${id}-error`].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function Notes({ id, p }: { id: string; p: Pick<Common, "error" | "review" | "hint"> }) {
  return (
    <>
      {p.review && (
        <span id={`${id}-review`} className="gcpe-review-mark">
          Changed: needs review
        </span>
      )}
      {p.hint && (
        <span id={`${id}-hint`} className="gcpe-hint">
          {p.hint}
        </span>
      )}
      {p.error?.length ? (
        <span id={`${id}-error`} className="gcpe-field-error">
          {p.error.join(" ")}
        </span>
      ) : null}
    </>
  );
}

function Label({ id, label, required }: { id: string; label: string; required?: boolean }) {
  return (
    <label htmlFor={id}>
      {label}
      {required && <span aria-hidden="true"> *</span>}
    </label>
  );
}

const wrap = (p: Pick<Common, "review">, base = "gcpe-field") => `${base}${p.review ? " gcpe-needs-review" : ""}`;
const invalid = (p: Pick<Common, "error">) => (p.error?.length ? true : undefined);

export function TextField(p: Common & { value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number }): React.JSX.Element {
  const attrs = {
    id: p.id,
    value: p.value,
    "aria-invalid": invalid(p),
    "aria-describedby": describedBy(p.id, p),
    "aria-required": p.required || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => p.onChange(e.target.value),
  };
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} required={p.required} />
      {p.multiline ? <textarea rows={p.rows ?? 3} {...attrs} /> : <input type="text" {...attrs} />}
      <Notes id={p.id} p={p} />
    </div>
  );
}

export function SelectField(p: Common & { value: string; onChange: (v: string) => void; options: Choice[]; empty?: string }): React.JSX.Element {
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} required={p.required} />
      <select id={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} aria-invalid={invalid(p)} aria-describedby={describedBy(p.id, p)} aria-required={p.required || undefined}>
        {p.empty !== undefined && <option value="">{p.empty}</option>}
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Notes id={p.id} p={p} />
    </div>
  );
}

export function CheckField(p: Common & { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className={wrap(p, "gcpe-check")}>
      <input type="checkbox" id={p.id} checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} aria-describedby={describedBy(p.id, p)} />
      <label htmlFor={p.id}>{p.label}</label>
      <Notes id={p.id} p={p} />
    </div>
  );
}

/** A set of checkboxes in its own fieldset: the multi-value fields (comm materials, shared-with, terms, translations). */
export function CheckList(p: Common & { values: readonly string[]; onChange: (v: string[]) => void; options: Choice[] }): React.JSX.Element {
  const toggle = (v: string, on: boolean) => p.onChange(on ? [...p.values, v] : p.values.filter((x) => x !== v));
  return (
    <fieldset id={p.id} className={wrap(p, "gcpe-checklist")} aria-describedby={describedBy(p.id, p)}>
      <legend>
        {p.label}
        {p.required && <span aria-hidden="true"> *</span>}
      </legend>
      {p.options.length === 0 ? (
        <p className="gcpe-hint">None to choose from.</p>
      ) : (
        <ul>
          {p.options.map((o, i) => (
            <li key={o.value}>
              <input type="checkbox" id={`${p.id}-${i}`} checked={p.values.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
              <label htmlFor={`${p.id}-${i}`}>{o.label}</label>
            </li>
          ))}
        </ul>
      )}
      <Notes id={p.id} p={p} />
    </fieldset>
  );
}

/** HQ Tags: free text, a new one is created on save (C146), with the active ones suggested. */
export function TagField(p: Common & { values: readonly string[]; onChange: (v: string[]) => void; suggestions: readonly string[] }): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !p.values.some((x) => x.toLowerCase() === v.toLowerCase())) p.onChange([...p.values, v]);
    setDraft("");
  };
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} />
      <div className="gcpe-tag-input">
        <input
          type="text"
          id={p.id}
          list={`${p.id}-suggestions`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-invalid={invalid(p)}
          aria-describedby={describedBy(p.id, p)}
        />
        <button type="button" className="gcpe-small-button" onClick={add}>
          Add tag
        </button>
      </div>
      <datalist id={`${p.id}-suggestions`}>
        {p.suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {p.values.length > 0 && (
        <ul className="gcpe-tags" aria-label={`${p.label} chosen`}>
          {p.values.map((v) => (
            <li key={v}>
              {v}{" "}
              <button type="button" className="gcpe-small-button" aria-label={`Remove ${p.label} ${v}`} onClick={() => p.onChange(p.values.filter((x) => x !== v))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Notes id={p.id} p={p} />
    </div>
  );
}

const timeLabel = (hhmm: string) => {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${hhmm.slice(3)} ${h < 12 ? "AM" : "PM"}`;
};
const TIMES: Choice[] = Array.from({ length: 288 }, (_, i) => {
  const value = `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`;
  return { value, label: timeLabel(value) };
});
/** The 5-minute steps, plus a stored time between them (an imported 9:07), so the select shows it rather than going blank. */
function timeChoices(current: string | null): Choice[] {
  if (current === null || TIMES.some((t) => t.value === current)) return TIMES;
  const extra = { value: current, label: `${timeLabel(current)} (not a 5-minute step)` };
  return [...TIMES.filter((t) => t.value < current), extra, ...TIMES.filter((t) => t.value > current)];
}

/** A date, and a time in 5-minute steps (spec addendum §7.2), unless the activity is all day. */
export function DateTimeField(p: {
  idDate: string;
  idTime: string;
  label: string;
  date: string | null;
  time: string | null;
  onDate: (v: string | null) => void;
  onTime: (v: string | null) => void;
  showTime: boolean;
  required?: boolean;
  dateError?: string[];
  timeError?: string[];
  review?: boolean;
  timeEmpty?: string;
}): React.JSX.Element {
  const dateNotes = { error: p.dateError, review: p.review };
  return (
    <div className="gcpe-datetime">
      <div className={wrap(p)}>
        <Label id={p.idDate} label={`${p.label} date`} required={p.required} />
        <input type="date" id={p.idDate} min="1900-01-01" max="2199-12-31" value={p.date ?? ""} onChange={(e) => p.onDate(e.target.value || null)} aria-invalid={invalid({ error: p.dateError })} aria-describedby={describedBy(p.idDate, dateNotes)} aria-required={p.required || undefined} />
        <Notes id={p.idDate} p={dateNotes} />
      </div>
      {p.showTime && (
        <SelectField id={p.idTime} label={`${p.label} time`} value={p.time ?? ""} onChange={(v) => p.onTime(v || null)} options={timeChoices(p.time)} empty={p.timeEmpty ?? "Choose a time"} required={p.required} error={p.timeError} review={p.review} />
      )}
    </div>
  );
}
