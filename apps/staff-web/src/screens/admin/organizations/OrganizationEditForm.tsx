import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../../../api/client";
import type { LinkSetting } from "@gcpe/site-settings";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { FIX_BELOW, fieldErrorsOf, messagesOf } from "../messages";
import type { OrgRecord } from "@gcpe/events/catalogue";
import {
  AbbreviationField,
  abbreviationTakenMessage,
  normalizeAbbreviation,
} from "./abbreviation";

export { ABBREVIATION_HINT } from "./abbreviation";

/** Shown after a successful save. The rebuild latency is unmeasured, so no time is promised. */
export const SAVED_MESSAGE =
  "Saved. The public Ministries page updates when the site next rebuilds.";

/** The confirmation shown before a ministry is deactivated, by the row button and the edit form's Active checkbox alike. */
export const deactivateWarning = (displayName: string): string =>
  `Deactivate ${displayName}? It disappears from the public site, and its subscribers stop receiving news. This can be undone with Reactivate, but subscribers are not moved to another ministry.`;

export interface OrganizationEditFormProps {
  org: OrgRecord;
  orgs: OrgRecord[];
  isAdmin: boolean;
  onSaved: (o: OrgRecord) => void;
  onCancel: () => void;
}

type MinisterField = "name" | "summary" | "email" | "photoUrl";
type AddressField = "url" | "flickrUrl" | "youtubeUrl";
type ListField = "topicLinks" | "serviceLinks";
type FieldError = { field: string; message: string };

/** The ministry page addresses, with the path Core reports their errors under. */
const ADDRESSES: { field: AddressField; path: string; label: string }[] = [
  { field: "url", path: "url", label: "Ministry website" },
  { field: "flickrUrl", path: "social.flickrUrl", label: "Photos (Flickr) address" },
  { field: "youtubeUrl", path: "social.youtubeUrl", label: "Videos (YouTube) address" },
];
const LISTS: { field: ListField; legend: string }[] = [
  { field: "topicLinks", legend: "Featured Topics" },
  { field: "serviceLinks", legend: "Featured Services" },
];
/** Fields whose server messages are shown beside them rather than at the top of the form. */
const INLINE_FIELD = /^(abbreviation|url|social\.(flickrUrl|youtubeUrl)|(topicLinks|serviceLinks)\[\d+\]\.\w+)$/;

const plainLinks = (links: { text: string; url: string }[]) =>
  links.map(({ text, url }) => ({ text, url }));

/**
 * Edits one organization's public-facing profile (`PATCH .../profile`). Only the fields the user
 * changed are sent (a changed link list is sent whole, minus rows left blank), so everything the
 * form doesn't show (details, address, contacts...) is untouched on the server. The server trims
 * and turns "" into null. Core.Admin also sees Parent ministry, Active and Abbreviation.
 */
export function OrganizationEditForm({
  org,
  orgs,
  isAdmin,
  onSaved,
  onCancel,
}: OrganizationEditFormProps): React.JSX.Element {
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
  // What the form opened with. The patch compares against these, not the live `org` prop, so a
  // row Deactivate/Reactivate that reloads the list can't be silently undone by saving this form.
  const [initial] = useState({
    parentKey: org.parentKey ?? "",
    isActive: org.isActive,
    abbreviation: normalizeAbbreviation(org.abbreviation ?? ""),
    addresses: {
      url: org.url ?? "",
      flickrUrl: org.social.flickrUrl ?? "",
      youtubeUrl: org.social.youtubeUrl ?? "",
    } satisfies Record<AddressField, string>,
    topicLinks: plainLinks(org.topicLinks),
    serviceLinks: plainLinks(org.serviceLinks),
  });
  const [parentKey, setParentKey] = useState(initial.parentKey);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [abbreviation, setAbbreviation] = useState(org.abbreviation ?? "");
  const [addresses, setAddresses] = useState(initial.addresses);
  const [lists, setLists] = useState<Record<ListField, LinkSetting[]>>({
    topicLinks: initial.topicLinks,
    serviceLinks: initial.serviceLinks,
  });
  // Server messages shown beside their fields; link rows by their index on screen.
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [removeBio, setRemoveBio] = useState(false);
  // The address the preview last failed to load, so a typo shows a message instead of a broken image.
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
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
  // Only a full https:// address is previewed — the same rule the server applies on save.
  const photo = minister.photoUrl.trim();
  const photoPreview = photo.startsWith("https://") ? photo : null;
  const hasBio = !!org.minister.detailsHtml;
  const ministerNameChanged =
    minister.name.trim() !== (org.minister.name ?? "");
  const parents = orgs.filter(
    (o) => o.key !== org.key && (o.isActive || o.key === org.parentKey),
  );

  // Each list as it would be sent (blank rows dropped), with the on-screen index of every sent row
  // so the server's `topicLinks[i]` errors land on the row the user sees.
  const sendable = (field: ListField) => {
    const kept = lists[field].flatMap((link, i) =>
      withoutBlankLinks([link]).length ? [i] : [],
    );
    return { links: plainLinks(kept.map((i) => lists[field][i]!)), kept };
  };

  const buildPatch = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (displayName.trim() !== org.displayName)
      body.displayName = displayName.trim();
    if (Number(sortTrimmed) !== org.sortOrder)
      body.sortOrder = Number(sortTrimmed);
    const m: Record<string, string | null> = {};
    for (const f of ["name", "summary", "email", "photoUrl"] as const) {
      if (minister[f].trim() !== (org.minister[f] ?? ""))
        m[f] = minister[f].trim();
    }
    if (hasBio && removeBio) m.detailsHtml = null;
    if (Object.keys(m).length > 0) body.minister = m;
    if (addresses.url.trim() !== initial.addresses.url)
      body.url = addresses.url.trim();
    const social: Record<string, string> = {};
    for (const f of ["flickrUrl", "youtubeUrl"] as const) {
      if (addresses[f].trim() !== initial.addresses[f])
        social[f] = addresses[f].trim();
    }
    if (Object.keys(social).length > 0) body.social = social;
    for (const { field } of LISTS) {
      const { links } = sendable(field);
      if (JSON.stringify(links) !== JSON.stringify(initial[field]))
        body[field] = links;
    }
    if (isAdmin) {
      if (parentKey !== initial.parentKey) body.parentKey = parentKey || null;
      if (isActive !== initial.isActive) body.isActive = isActive;
      if (normalizeAbbreviation(abbreviation) !== initial.abbreviation)
        body.abbreviation = normalizeAbbreviation(abbreviation);
    }
    return body;
  };

  /** Splits a failed save's messages: beside their fields where the form has one, else at the top. */
  const showErrors = (caught: unknown) => {
    const taken = abbreviationTakenMessage(caught);
    const issues: FieldError[] =
      taken !== null
        ? [{ field: "abbreviation", message: taken }]
        : fieldErrorsOf(caught);
    const inline = issues
      .filter((e) => INLINE_FIELD.test(e.field))
      .map((e) => {
        const row = /^(topicLinks|serviceLinks)\[(\d+)\](.*)$/.exec(e.field);
        if (!row) return e;
        const shown = sendable(row[1] as ListField).kept[Number(row[2])];
        return { ...e, field: `${row[1]}[${shown ?? row[2]}]${row[3]}` };
      });
    const rest = issues.filter((e) => !INLINE_FIELD.test(e.field));
    setFieldErrors(inline);
    setMessages(
      inline.length === 0
        ? messagesOf(caught)
        : [FIX_BELOW, ...rest.map((e) => e.message)],
    );
  };
  const errorFor = (path: string) =>
    fieldErrors.find((e) => e.field === path)?.message;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameBlank || sortInvalid || busy) return;
    setMessages([]);
    setFieldErrors([]);
    setStatus(null);
    const body = buildPatch();
    if (Object.keys(body).length === 0) {
      setStatus("No changes to save.");
      return;
    }
    setBusy(true);
    try {
      const updated = await apiFetch<OrgRecord>(
        `/core/api/organizations/${encodeURIComponent(org.key)}/profile`,
        { method: "PATCH", body },
      );
      setStatus(SAVED_MESSAGE);
      onSaved(updated);
    } catch (caught) {
      showErrors(caught);
    } finally {
      setBusy(false);
    }
  };

  const setM =
    (f: MinisterField) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setMinister((m) => ({ ...m, [f]: e.target.value }));
  const id = (s: string) => `${uid}-${s}`;

  return (
    <form
      onSubmit={save}
      aria-label={`Edit ${org.displayName}`}
      className="gcpe-stack"
      noValidate
    >
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
        <input
          id={id("name")}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-invalid={nameBlank}
          aria-describedby={nameBlank ? id("name-err") : undefined}
        />
        {nameBlank && <p id={id("name-err")}>Enter a ministry name.</p>}
      </div>

      <div>
        <label htmlFor={id("sort")}>Sort order</label>
        <input
          id={id("sort")}
          type="text"
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          aria-invalid={sortInvalid}
          aria-describedby={sortInvalid ? id("sort-err") : undefined}
        />
        {sortInvalid && <p id={id("sort-err")}>Enter a whole number.</p>}
      </div>

      <div>
        <label htmlFor={id("mname")}>Minister name</label>
        <p id={id("mname-hint")}>
          Include the title, e.g. &quot;Honourable Jane Doe&quot; or
          &quot;Premier Jane Doe&quot;.
        </p>
        <input
          id={id("mname")}
          type="text"
          value={minister.name}
          onChange={setM("name")}
          aria-describedby={id("mname-hint")}
        />
        {ministerBlank && (
          <p>This ministry will show no minister on the public site.</p>
        )}
      </div>

      {hasBio && (
        <div>
          <input
            id={id("mbio")}
            type="checkbox"
            checked={removeBio}
            onChange={(e) => setRemoveBio(e.target.checked)}
            aria-describedby={id("mbio-hint")}
          />{" "}
          <label htmlFor={id("mbio")}>
            Remove the previous minister&apos;s biography
          </label>
          <p id={id("mbio-hint")}>
            The biography on the public ministry page belongs to the current
            minister. Remove it when the minister changes.
          </p>
          {ministerNameChanged && !removeBio && (
            <p>
              The public page still shows the previous minister&apos;s
              biography.
            </p>
          )}
        </div>
      )}

      <div>
        <label htmlFor={id("msummary")}>Minister summary</label>
        <textarea
          id={id("msummary")}
          rows={3}
          value={minister.summary}
          onChange={setM("summary")}
        />
      </div>

      <div>
        <label htmlFor={id("memail")}>Minister email</label>
        <input
          id={id("memail")}
          type="email"
          value={minister.email}
          onChange={setM("email")}
        />
      </div>

      <div className="gcpe-field gcpe-field--wide">
        <label htmlFor={id("mphoto")}>Minister photo URL</label>
        <p id={id("mphoto-hint")}>
          Upload the photo under Website → Files, then paste its address here.
        </p>
        <input
          id={id("mphoto")}
          type="text"
          value={minister.photoUrl}
          onChange={setM("photoUrl")}
          aria-describedby={`${id("mphoto-hint")} ${id("mphoto-preview")}`}
        />
        <div
          id={id("mphoto-preview")}
          className="gcpe-photo-preview"
          aria-live="polite"
        >
          {photoPreview === null ? (
            photo !== "" && (
              <p>
                Enter the full address, starting with https://, to see a
                preview.
              </p>
            )
          ) : failedPhoto === photoPreview ? (
            <p>
              This address didn&apos;t load an image. Check that it&apos;s the
              right URL.
            </p>
          ) : (
            <img
              src={photoPreview}
              alt="Preview of the minister photo"
              onError={() => setFailedPhoto(photoPreview)}
            />
          )}
        </div>
      </div>

      <fieldset className="gcpe-stack">
        <legend>Ministry page links</legend>
        {ADDRESSES.map(({ field, path, label }) => {
          const error = errorFor(path);
          return (
            <div key={field} className="gcpe-field gcpe-field--wide">
              <label htmlFor={id(field)}>{label}</label>
              <input
                id={id(field)}
                type="url"
                value={addresses[field]}
                onChange={(e) =>
                  setAddresses((a) => ({ ...a, [field]: e.target.value }))
                }
                aria-invalid={error !== undefined}
                aria-describedby={
                  error !== undefined ? id(`${field}-err`) : undefined
                }
              />
              {error !== undefined && <p id={id(`${field}-err`)}>{error}</p>}
            </div>
          );
        })}
        {LISTS.map(({ field, legend }) => (
          <LinkListEditor
            key={field}
            legend={legend}
            links={lists[field]}
            onChange={(links) => setLists((l) => ({ ...l, [field]: links }))}
            errors={fieldErrors}
            pathPrefix={field}
            reorderable
            withSummary={false}
          />
        ))}
      </fieldset>

      {isAdmin && (
        <>
          <AbbreviationField
            id={id("abbr")}
            value={abbreviation}
            onChange={setAbbreviation}
            error={errorFor("abbreviation")}
          />
          <div>
            <label htmlFor={id("parent")}>Parent ministry</label>
            <select
              id={id("parent")}
              value={parentKey}
              onChange={(e) => setParentKey(e.target.value)}
            >
              <option value="">None</option>
              {parents.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <input
              id={id("active")}
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />{" "}
            <label htmlFor={id("active")}>Active</label>
            {initial.isActive && !isActive && (
              <p role="note">{deactivateWarning(org.displayName)}</p>
            )}
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
