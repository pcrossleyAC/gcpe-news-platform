import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../../../api/client";
import type { LinkSetting } from "@gcpe/site-settings";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useAnnouncer } from "../../../shared/Announcer";
import { BodyEditor } from "../../../editor/BodyEditor";
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
type ListField = "topicLinks" | "serviceLinks" | "teamLinks";
type FieldError = { field: string; message: string };
type ContactKey = "contact" | "secondContact";
type ContactField = "fullName" | "phoneNumber" | "mobileNumber" | "emailAddress";
type ContactValues = Record<ContactField, string>;

const CONTACT_FIELDS: ContactField[] = ["fullName", "phoneNumber", "mobileNumber", "emailAddress"];
const CONTACTS: { key: ContactKey; legend: string }[] = [
  { key: "contact", legend: "Primary contact" },
  { key: "secondContact", legend: "Alternate contact" },
];
/** Each contact input: its label, input type, and the hint saying how the public page shows it. */
const CONTACT_INPUTS: { field: ContactField; label: string; type: "text" | "tel" | "email"; hint?: string }[] = [
  { field: "fullName", label: "Name", type: "text" },
  { field: "phoneNumber", label: "Phone", type: "tel", hint: "Shown as Direct on the ministry page." },
  { field: "mobileNumber", label: "Cell", type: "tel" },
  { field: "emailAddress", label: "Email", type: "email" },
];
/** A stored contact as the form's trimmed baseline (no contact at all is four blanks). */
const contactValues = (c: OrgRecord["contact"]): ContactValues => ({
  fullName: c?.fullName?.trim() ?? "",
  phoneNumber: c?.phoneNumber?.trim() ?? "",
  mobileNumber: c?.mobileNumber?.trim() ?? "",
  emailAddress: c?.emailAddress?.trim() ?? "",
});
const contactBlank = (c: ContactValues) => CONTACT_FIELDS.every((f) => c[f].trim() === "");

export const BIO_HINT =
  "Shown on the minister's biography page, linked as Read Bio from the ministry page. Leave it empty for no biography page.";
export const TEAM_LINKS_DESCRIPTION =
  "Shown as Meet the Team on the ministry page (the Office of the Premier uses it for Cabinet Ministers, Deputy Ministers and Cabinet Committees).";

/**
 * The biography as the PATCH sends it: editor HTML with no text (the emptied editor's `<p></p>`,
 * an empty list, a lone `&nbsp;`) is null, which removes the biography page. Mirrors Core's
 * isBlankHtml, which turns the same HTML into null on its side.
 */
export function bioToPatch(html: string): string | null {
  const text = html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\u00a0/g, " ");
  return text.trim() === "" ? null : html;
}

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
const INLINE_FIELD =
  /^(abbreviation|url|social\.(flickrUrl|youtubeUrl)|minister\.detailsHtml|(contact|secondContact)\.\w+|weekendContactNumber|(topicLinks|serviceLinks|teamLinks)\[\d+\]\.\w+)$/;
const LIST_ROW = /^(topicLinks|serviceLinks|teamLinks)\[(\d+)\](.*)$/;

const plainLinks = (links: { text: string; url: string }[]) =>
  links.map(({ text, url }) => ({ text, url }));

/**
 * Edits one organization's public-facing profile (`PATCH .../profile`): the minister (including the
 * biography, in the release body editor without assets), the Meet the Team links, the two media
 * contacts and the after-hours phone, and the ministry page links. Only the fields the user
 * changed are sent: a changed link list is sent whole, minus rows left blank; a changed contact is
 * sent whole, all four fields, blanks as ""; the biography only when its text changed, with an
 * emptied editor as null. Everything the form doesn't show (the minister's mailing address...) is
 * untouched on the server. The server trims, turns "" into null and sanitises the biography.
 * Core.Admin also sees Parent ministry, Active and Abbreviation.
 */
export function OrganizationEditForm({
  org,
  orgs,
  isAdmin,
  onSaved,
  onCancel,
}: OrganizationEditFormProps): React.JSX.Element {
  const uid = useId();
  const { announce } = useAnnouncer();
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
    teamLinks: plainLinks(org.teamLinks ?? []),
    bio: org.minister.detailsHtml ?? null,
    contacts: {
      contact: contactValues(org.contact),
      secondContact: contactValues(org.secondContact),
    } satisfies Record<ContactKey, ContactValues>,
    weekendContactNumber: org.weekendContactNumber?.trim() ?? "",
  });
  const [parentKey, setParentKey] = useState(initial.parentKey);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [abbreviation, setAbbreviation] = useState(org.abbreviation ?? "");
  const [addresses, setAddresses] = useState(initial.addresses);
  const [lists, setLists] = useState<Record<ListField, LinkSetting[]>>({
    topicLinks: initial.topicLinks,
    serviceLinks: initial.serviceLinks,
    teamLinks: initial.teamLinks,
  });
  // The editor's HTML. It only changes when the user edits, so an untouched biography is the
  // stored HTML exactly and is never sent.
  const [bio, setBio] = useState(initial.bio ?? "");
  const [contacts, setContacts] = useState(initial.contacts);
  const [weekendContactNumber, setWeekendContactNumber] = useState(
    initial.weekendContactNumber,
  );
  // Server messages shown beside their fields; link rows by their index on screen.
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  // Set when "Clear the biography" empties the editor, so focus moves into it once it has re-rendered.
  const focusBio = useRef(false);
  // The address the preview last failed to load, so a typo shows a message instead of a broken image.
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!focusBio.current) return;
    focusBio.current = false;
    document.getElementById(id("mbio"))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bio]);

  const nameBlank = displayName.trim() === "";
  const sortTrimmed = sortOrder.trim();
  const sortInvalid = !/^-?\d+$/.test(sortTrimmed);
  const ministerBlank = minister.name.trim() === "";
  // Only a full https:// address is previewed — the same rule the server applies on save.
  const photo = minister.photoUrl.trim();
  const photoPreview = photo.startsWith("https://") ? photo : null;
  const bioPatch = bioToPatch(bio);
  const bioChanged = bioPatch !== initial.bio;
  const ministerNameChanged =
    minister.name.trim() !== (org.minister.name ?? "");
  // The stored biography is kept while the minister is renamed: it now describes someone else.
  const bioOutdated = initial.bio !== null && !bioChanged && ministerNameChanged;
  const alternateOnly =
    contactBlank(contacts.contact) && !contactBlank(contacts.secondContact);
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
    if (bioChanged) m.detailsHtml = bioPatch;
    if (Object.keys(m).length > 0) body.minister = m;
    if (addresses.url.trim() !== initial.addresses.url)
      body.url = addresses.url.trim();
    const social: Record<string, string> = {};
    for (const f of ["flickrUrl", "youtubeUrl"] as const) {
      if (addresses[f].trim() !== initial.addresses[f])
        social[f] = addresses[f].trim();
    }
    if (Object.keys(social).length > 0) body.social = social;
    for (const { key } of CONTACTS) {
      const c = contacts[key];
      if (CONTACT_FIELDS.some((f) => c[f].trim() !== initial.contacts[key][f]))
        body[key] = Object.fromEntries(
          CONTACT_FIELDS.map((f) => [f, c[f].trim()]),
        );
    }
    if (weekendContactNumber.trim() !== initial.weekendContactNumber)
      body.weekendContactNumber = weekendContactNumber.trim();
    for (const field of ["teamLinks", "topicLinks", "serviceLinks"] as const) {
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
        const row = LIST_ROW.exec(e.field);
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

  const clearBio = () => {
    focusBio.current = true;
    setBio("");
    announce("Biography cleared.");
  };
  const bioError = errorFor("minister.detailsHtml");
  const bioDescribedBy = [
    id("mbio-hint"),
    bioOutdated ? id("mbio-note") : null,
    bioError !== undefined ? id("mbio-err") : null,
  ]
    .filter(Boolean)
    .join(" ");
  const weekendError = errorFor("weekendContactNumber");

  return (
    <form
      onSubmit={save}
      aria-label={`Edit ${org.displayName}`}
      className="gcpe-stack gcpe-org-form"
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

      <div className="gcpe-field gcpe-field--wide gcpe-org-bio">
        <BodyEditor
          id={id("mbio")}
          label="Minister biography"
          value={bio}
          onChange={setBio}
          readOnly={false}
          allowAssets={false}
          describedBy={bioDescribedBy}
        />
        <p id={id("mbio-hint")}>{BIO_HINT}</p>
        {bioOutdated && (
          <p id={id("mbio-note")} role="note">
            The biography still describes the previous minister.
          </p>
        )}
        {bioError !== undefined && (
          <p id={id("mbio-err")} className="gcpe-link-list__error">
            {bioError}
          </p>
        )}
        {bioPatch !== null && (
          <div>
            <button type="button" onClick={clearBio}>
              Clear the biography
            </button>
          </div>
        )}
      </div>

      <LinkListEditor
        legend="Meet the Team links"
        description={TEAM_LINKS_DESCRIPTION}
        links={lists.teamLinks}
        onChange={(links) => setLists((l) => ({ ...l, teamLinks: links }))}
        errors={fieldErrors}
        pathPrefix="teamLinks"
        reorderable
        withSummary={false}
      />

      <fieldset className="gcpe-stack gcpe-link-set">
        <legend>Media contacts</legend>
        {CONTACTS.map(({ key, legend }) => (
          <fieldset key={key} className="gcpe-stack gcpe-org-contact">
            <legend>{legend}</legend>
            {CONTACT_INPUTS.map(({ field, label, type, hint }) => {
              const fieldId = id(`${key}-${field}`);
              const error = errorFor(`${key}.${field}`);
              const describedBy = [
                hint !== undefined ? `${fieldId}-hint` : null,
                error !== undefined ? `${fieldId}-err` : null,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div key={field}>
                  <label htmlFor={fieldId}>{label}</label>
                  {hint !== undefined && <p id={`${fieldId}-hint`}>{hint}</p>}
                  <input
                    id={fieldId}
                    type={type}
                    autoComplete="off"
                    value={contacts[key][field]}
                    onChange={(e) =>
                      setContacts((c) => ({
                        ...c,
                        [key]: { ...c[key], [field]: e.target.value },
                      }))
                    }
                    aria-invalid={error !== undefined}
                    aria-describedby={describedBy || undefined}
                  />
                  {error !== undefined && (
                    <p id={`${fieldId}-err`} className="gcpe-link-list__error">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
        {alternateOnly && (
          <p role="note">
            The public page shows the alternate only with a primary contact.
          </p>
        )}
        <div>
          <label htmlFor={id("weekend")}>After-hours phone</label>
          <input
            id={id("weekend")}
            type="tel"
            autoComplete="off"
            value={weekendContactNumber}
            onChange={(e) => setWeekendContactNumber(e.target.value)}
            aria-invalid={weekendError !== undefined}
            aria-describedby={
              weekendError !== undefined ? id("weekend-err") : undefined
            }
          />
          {weekendError !== undefined && (
            <p id={id("weekend-err")} className="gcpe-link-list__error">
              {weekendError}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="gcpe-stack gcpe-link-set">
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
