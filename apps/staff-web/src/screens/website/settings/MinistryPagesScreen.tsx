import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { MINISTRY_PAGE_LABEL_KEYS, type MinistryPageLabels } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { ResetToDefaults } from "./ResetToDefaults";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Ministry page headings";

export const FIELD_LABEL: Record<keyof MinistryPageLabels, string> = {
  moreFromMinistry: "More from this Ministry heading",
  ministryWebsite: "Ministry website heading",
  ministryPhotos: "Ministry photos heading",
  ministryVideos: "Ministry videos heading",
  featuredTopics: "Featured topics heading",
  featuredServices: "Featured services heading",
  mediaContacts: "Media contacts heading",
};

/**
 * `/hub/website/ministry-pages` (spec "Hub screens", Ministry pages): the seven headings on a
 * ministry's page, one text field each. Reads need NRMS.SiteEditor or Core.Admin; writes
 * NRMS.SiteEditor.
 */
export function MinistryPagesScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-ministry-pages">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the ministry page headings.</p>
      </div>
    );
  }
  return <MinistryPagesFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function MinistryPagesFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"ministryPages">("ministryPages");
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-ministry-pages">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-ministry-pages">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="gcpe-site-ministry-pages">
      <h1>{TITLE}</h1>

      {MINISTRY_PAGE_LABEL_KEYS.map((key) => {
        const message = fieldErrors.find((e) => e.field === `ministryPages.${key}`)?.message;
        return (
          <TextField
            key={key}
            label={FIELD_LABEL[key]}
            value={value[key]}
            onChange={(heading) => editor.setValue((v) => ({ ...v, [key]: heading }))}
            isDisabled={!canEdit}
            isInvalid={message !== undefined}
            errorMessage={message}
          />
        );
      })}

      {canEdit && <ResetToDefaults editor={editor as SettingsEditor<unknown>} apply={(d) => editor.setValue(d.ministryPages)} done="Headings reset to the defaults. Save or publish to keep them." />}

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="ministryPages" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
