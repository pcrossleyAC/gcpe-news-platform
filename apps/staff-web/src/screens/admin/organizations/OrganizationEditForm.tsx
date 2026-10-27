import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../../../api/client";
import { messagesOf } from "../messages";
import type { OrgRecord } from "@gcpe/events/catalogue";

/** Shown after a successful save. The rebuild latency is unmeasured, so no time is promised. */
export const SAVED_MESSAGE = "Saved. The public Ministries page updates when the site next rebuilds.";

export interface OrganizationEditFormProps {
  org: OrgRecord;
  orgs: OrgRecord[];
  isAdmin: boolean;
  onSaved: (o: OrgRecord) => void;
  onCancel: () => void;
}

type MinisterField = "name" | "summary" | "email" | "photoUrl";

/**
 * Edits one organization's public-facing profile (`PATCH .../profile`). Only the fields the user
 * changed are sent, so everything the form doesn't show (details, address, contacts, links...)
 * is untouched on the server. The server trims and turns "" into null.
 */
export function OrganizationEditForm({ org, orgs, isAdmin, onSaved, onCancel }: OrganizationEditFormProps): React.JSX.Element {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [displayName, setDisplayName] = useState(org.displayName);
  const [sortOrder, setSortOrder] = useState(String(org.sortOrder));
  const [minister, setMinister] = useState<Record<MinisterField, string>>({
    name: org.minister.name ?? "",
    summary: org.minister.summary ?? "",
    email: org.minister.email ?? "",
    photoUrl: org.minister.photoUrl ?? "",
  });
  const [parentKey, setParentKey] = useState(org.parentKey ?? "");
  const [isActive, setIsActive] = useState(org.isActive);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const nameBlank = displayName.trim() === "";
  const sortTrimmed = sortOrder.trim();
  const sortInvalid = !/^-?\d+$/.test(sortTrimmed);
  const ministerBlank = minister.name.trim() === "";
  const parents = orgs.filter((o) => o.key !== org.key && (o.isActive || o.key === org.parentKey));

  const buildPatch = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (displayName.trim() !== org.displayName) body.displayName = displayName.trim();
    if (Number(sortTrimmed) !== org.sortOrder) body.sortOrder = Number(sortTrimmed);
    const m: Record<string, string> = {};
    for (const f of ["name", "summary", "email", "photoUrl"] as const) {
      if (minister[f].trim() !== (org.minister[f] ?? "")) m[f] = minister[f].trim();
    }
    if (Object.keys(m).length > 0) body.minister = m;
    if (isAdmin) {
      if ((parentKey || null) !== (org.parentKey ?? null)) body.parentKey = parentKey || null;
      if (isActive !== org.isActive) body.isActive = isActive;
    }
    return body;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameBlank || sortInvalid || busy) return;
    setMessages([]);
    setStatus(null);
    const body = buildPatch();
    if (Object.keys(body).length === 0) {
      setStatus("No changes to save.");
      return;
    }
    setBusy(true);
    try {
      const updated = await apiFetch<OrgRecord>(`/core/api/organizations/${encodeURIComponent(org.key)}/profile`, { method: "PATCH", body });
      setStatus(SAVED_MESSAGE);
      onSaved(updated);
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const setM = (f: MinisterField) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setMinister((m) => ({ ...m, [f]: e.target.value }));
  const id = (s: string) => `${uid}-${s}`;

  return (
    <form onSubmit={save} aria-label={`Edit ${org.displayName}`} className="gcpe-stack" noValidate>
      <h2 ref={headingRef} tabIndex={-1}>
        Edit {org.displayName}
      </h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}

      <div>
        <label htmlFor={id("name")}>Ministry name (required)</label>
        <input id={id("name")} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={nameBlank} aria-describedby={nameBlank ? id("name-err") : undefined} />
        {nameBlank && <p id={id("name-err")}>Enter a ministry name.</p>}
      </div>

      <div>
        <label htmlFor={id("sort")}>Sort order</label>
        <input id={id("sort")} type="text" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} aria-invalid={sortInvalid} aria-describedby={sortInvalid ? id("sort-err") : undefined} />
        {sortInvalid && <p id={id("sort-err")}>Enter a whole number.</p>}
      </div>

      <div>
        <label htmlFor={id("mname")}>Minister name</label>
        <p id={id("mname-hint")}>Include the title, e.g. &quot;Honourable Jane Doe&quot; or &quot;Premier Jane Doe&quot;.</p>
        <input id={id("mname")} type="text" value={minister.name} onChange={setM("name")} aria-describedby={id("mname-hint")} />
        {ministerBlank && <p>This ministry will show no minister on the public site.</p>}
      </div>

      <div>
        <label htmlFor={id("msummary")}>Minister summary</label>
        <textarea id={id("msummary")} rows={3} value={minister.summary} onChange={setM("summary")} />
      </div>

      <div>
        <label htmlFor={id("memail")}>Minister email</label>
        <input id={id("memail")} type="email" value={minister.email} onChange={setM("email")} />
      </div>

      <div>
        <label htmlFor={id("mphoto")}>Minister photo URL</label>
        <p id={id("mphoto-hint")}>Upload the photo under Website → Files, then paste its address here.</p>
        <input id={id("mphoto")} type="text" value={minister.photoUrl} onChange={setM("photoUrl")} aria-describedby={id("mphoto-hint")} />
      </div>

      {isAdmin && (
        <>
          <div>
            <label htmlFor={id("parent")}>Parent ministry</label>
            <select id={id("parent")} value={parentKey} onChange={(e) => setParentKey(e.target.value)}>
              <option value="">None</option>
              {parents.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <input id={id("active")} type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />{" "}
            <label htmlFor={id("active")}>Active</label>
          </div>
        </>
      )}

      <div>
        <button type="submit" disabled={busy || nameBlank || sortInvalid}>
          Save
        </button>{" "}
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
