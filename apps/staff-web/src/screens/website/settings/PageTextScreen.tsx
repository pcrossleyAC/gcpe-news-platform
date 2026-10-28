import { useId } from "react";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import type { PageTextSettings } from "@gcpe/site-settings";
import { BodyEditor } from "../../../editor/BodyEditor";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { blankIfEmptyHtml } from "./format";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Page text";

export const INTRO =
  "The wording on the pages that are not news releases. The page not found heading and the privacy page title are required. Leave any other box empty to hide that wording.";

export const STATEMENT_HINT =
  "The title above is the page's main heading. For a heading inside the statement, put bold text on a line of its own.";

export const LICENCE_HINT =
  "Shown after the media assets list on each release as the text, then the link, then a period. The period is added for you.";

export const NOTICE_WARNING =
  "This is legal wording. Changes may need review by your privacy office before you publish.";

/**
 * `/hub/website/page-text`: the wording of the pages that are not releases — page not found,
 * privacy, live webcast, the subscribe page's Notice of Collection and help line, the media assets
 * licence, and the older-archive links on search. Reads need NRMS.SiteEditor or Core.Admin;
 * writes NRMS.SiteEditor.
 */
export function PageTextScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-page-text">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the page text.</p>
      </div>
    );
  }
  return <PageTextFields canEdit={session.has("NRMS.SiteEditor")} />;
}

interface RichFieldProps {
  label: string;
  value: string;
  onChange(html: string): void;
  hint?: string;
  error?: string;
  readOnly: boolean;
}

/** A rich-text field with its hint and server error tied to the editing area. */
function RichField({ label, value, onChange, hint, error, readOnly }: RichFieldProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error !== undefined ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="gcpe-field gcpe-field--wide">
      <BodyEditor id={`${id}-editor`} label={label} value={value} onChange={onChange} readOnly={readOnly} allowAssets={false} describedBy={describedBy || undefined} />
      {hint && <p id={hintId}>{hint}</p>}
      {error !== undefined && (
        <p id={errorId} role="alert" className="gcpe-link-list__error">
          {error}
        </p>
      )}
    </div>
  );
}

function PageTextFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"pageText">("pageText", {
    fromDocument: (pageText) => pageText,
    // A cleared rich-text box is sent as "" (not the editor's "<p></p>"); blank archive rows are
    // dropped, and the hook then shows the saved document so error indexes match it.
    toRequest: (pageText) => ({
      ...pageText,
      privacy: { ...pageText.privacy, bodyHtml: blankIfEmptyHtml(pageText.privacy.bodyHtml) },
      live: { ...pageText.live, consentHtml: blankIfEmptyHtml(pageText.live.consentHtml), offAirHtml: blankIfEmptyHtml(pageText.live.offAirHtml) },
      collectionNotice: { ...pageText.collectionNotice, bodyHtml: blankIfEmptyHtml(pageText.collectionNotice.bodyHtml) },
      subscribeHelpHtml: blankIfEmptyHtml(pageText.subscribeHelpHtml),
      searchArchiveLinks: withoutBlankLinks(pageText.searchArchiveLinks),
    }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-page-text">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-page-text">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const message = (field: string) => fieldErrors.find((e) => e.field === `pageText.${field}`)?.message;
  const errorOf = (field: string) => {
    const m = message(field);
    return { errorMessage: m, isInvalid: m !== undefined };
  };
  const set = (patch: Partial<PageTextSettings>) => editor.setValue((v) => ({ ...v, ...patch }));
  const text = (field: string, label: string, current: string, apply: (v: string) => void, description?: string) => (
    <TextField label={label} description={description} value={current} onChange={apply} isDisabled={!canEdit} {...errorOf(field)} />
  );

  return (
    <div className="gcpe-site-page-text">
      <h1>{TITLE}</h1>
      <p>{INTRO}</p>

      <fieldset>
        <legend>Page not found</legend>
        {text("notFound.heading", "Heading", value.notFound.heading, (heading) => set({ notFound: { ...value.notFound, heading } }))}
        {text("notFound.text", "Text", value.notFound.text, (t) => set({ notFound: { ...value.notFound, text: t } }), "Shown when a visitor opens a page that does not exist.")}
      </fieldset>

      <fieldset>
        <legend>Privacy page</legend>
        {text("privacy.label", "Label", value.privacy.label, (label) => set({ privacy: { ...value.privacy, label } }), "Shown above the title on the privacy page. Leave it empty to hide it.")}
        {text("privacy.title", "Title", value.privacy.title, (title) => set({ privacy: { ...value.privacy, title } }))}
        <RichField
          label="Statement"
          value={value.privacy.bodyHtml}
          onChange={(bodyHtml) => set({ privacy: { ...value.privacy, bodyHtml } })}
          hint={STATEMENT_HINT}
          error={message("privacy.bodyHtml")}
          readOnly={!canEdit}
        />
      </fieldset>

      <fieldset>
        <legend>Live webcast page</legend>
        {text("live.heading", "Heading", value.live.heading, (heading) => set({ live: { ...value.live, heading } }))}
        <RichField
          label="Before play"
          value={value.live.consentHtml}
          onChange={(consentHtml) => set({ live: { ...value.live, consentHtml } })}
          hint="{host} is replaced by the stream's host name."
          error={message("live.consentHtml")}
          readOnly={!canEdit}
        />
        <RichField
          label="When not live"
          value={value.live.offAirHtml}
          onChange={(offAirHtml) => set({ live: { ...value.live, offAirHtml } })}
          error={message("live.offAirHtml")}
          readOnly={!canEdit}
        />
      </fieldset>

      <fieldset>
        <legend>Subscribe page</legend>
        {text("collectionNotice.heading", "Notice heading", value.collectionNotice.heading, (heading) => set({ collectionNotice: { ...value.collectionNotice, heading } }))}
        <RichField
          label="Notice of Collection"
          value={value.collectionNotice.bodyHtml}
          onChange={(bodyHtml) => set({ collectionNotice: { ...value.collectionNotice, bodyHtml } })}
          hint={NOTICE_WARNING}
          error={message("collectionNotice.bodyHtml")}
          readOnly={!canEdit}
        />
        <RichField
          label="Help line"
          value={value.subscribeHelpHtml}
          onChange={(subscribeHelpHtml) => set({ subscribeHelpHtml })}
          error={message("subscribeHelpHtml")}
          readOnly={!canEdit}
        />
      </fieldset>

      <fieldset>
        <legend>Media assets licence</legend>
        {text("assetLicence.text", "Text", value.assetLicence.text, (t) => set({ assetLicence: { ...value.assetLicence, text: t } }), LICENCE_HINT)}
        {text("assetLicence.linkText", "Link text", value.assetLicence.linkText, (linkText) => set({ assetLicence: { ...value.assetLicence, linkText } }))}
        {text("assetLicence.url", "Link URL", value.assetLicence.url, (url) => set({ assetLicence: { ...value.assetLicence, url } }))}
      </fieldset>

      <LinkListEditor
        legend="Search: older archives"
        description="Links to older news archives, shown on the search page."
        links={value.searchArchiveLinks}
        onChange={(searchArchiveLinks) => set({ searchArchiveLinks })}
        errors={fieldErrors}
        pathPrefix="pageText.searchArchiveLinks"
        reorderable
        withSummary={false}
        isDisabled={!canEdit}
      />

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="pageText" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
