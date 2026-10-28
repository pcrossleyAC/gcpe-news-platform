import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import type { ContactsPageSettings } from "@gcpe/site-settings";
import { BodyEditor } from "../../../editor/BodyEditor";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { DirectoryContactsEditor, withoutBlankContacts } from "./DirectoryContactsEditor";
import { blankIfEmptyHtml } from "./format";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Media contacts page";
const INTRO_ERROR_ID = "media-contacts-intro-error";
const INTRO_HINT_ID = "media-contacts-intro-hint";

/**
 * `/hub/website/media-contacts`: the headings and introduction of the public Media contacts
 * page, and the contacts listed above and below the ministries. Reads need NRMS.SiteEditor or
 * Core.Admin; writes NRMS.SiteEditor.
 */
export function MediaContactsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-footer">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the media contacts page.</p>
      </div>
    );
  }
  return <MediaContactsFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function MediaContactsFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"contactsPage">("contactsPage", {
    fromDocument: (page) => page,
    // Blank rows are dropped before sending; the hook then shows the saved document, so the form's
    // rows (and every error index) match what the server checked.
    toRequest: (page) => ({ ...page, introHtml: blankIfEmptyHtml(page.introHtml), contacts: withoutBlankContacts(page.contacts) }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-footer">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-footer">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const errorOf = (field: string) => {
    const message = fieldErrors.find((e) => e.field === `contactsPage.${field}`)?.message;
    return { errorMessage: message, isInvalid: message !== undefined };
  };
  const set = (patch: Partial<ContactsPageSettings>) => editor.setValue((v) => ({ ...v, ...patch }));
  const introError = errorOf("introHtml").errorMessage;

  return (
    <div className="gcpe-site-footer">
      <h1>{TITLE}</h1>

      <TextField label="Page heading" value={value.heading} onChange={(heading) => set({ heading })} isDisabled={!canEdit} {...errorOf("heading")} />
      <TextField label="Contact line heading" value={value.lineHeading} onChange={(lineHeading) => set({ lineHeading })} isDisabled={!canEdit} {...errorOf("lineHeading")} />
      <div>
        <BodyEditor
          id="media-contacts-intro"
          label="Introduction"
          value={value.introHtml}
          onChange={(introHtml) => set({ introHtml })}
          readOnly={!canEdit}
          allowAssets={false} allowItalic
          describedBy={introError ? `${INTRO_HINT_ID} ${INTRO_ERROR_ID}` : INTRO_HINT_ID}
        />
        <p id={INTRO_HINT_ID}>Include the 24-hour media line number here.</p>
        {introError && (
          <p id={INTRO_ERROR_ID} role="alert" className="gcpe-link-list__error">
            {introError}
          </p>
        )}
      </div>
      <TextField label="List heading" value={value.listHeading} onChange={(listHeading) => set({ listHeading })} isDisabled={!canEdit} {...errorOf("listHeading")} />

      <DirectoryContactsEditor
        value={value.contacts}
        onChange={(contacts) => set({ contacts })}
        errors={fieldErrors}
        pathPrefix="contactsPage.contacts"
        disabled={!canEdit}
      />
      {fieldErrors
        .filter((e) => e.field === "contactsPage.contacts")
        .map((e) => (
          <p key={e.message} role="alert" className="gcpe-link-list__error">
            {e.message}
          </p>
        ))}

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="contactsPage" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
