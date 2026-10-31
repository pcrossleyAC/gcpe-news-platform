import { InlineAlert, TextArea, TextField } from "@bcgov/design-system-react-components";
import type { FooterSettings } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { formatInZone } from "../../../format/bcTime";
import { useSession } from "../../../session/SessionContext";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Footer links";

const LISTS = [
  { field: "helpLinks", legend: "Help links" },
  { field: "connectLinks", legend: "Connect with Us links" },
  { field: "moreInfoLinks", legend: "More Info links" },
] as const;

/**
 * `/hub/website/footer` (spec "Hub screens", Footer): help text and links, Connect with Us
 * links, More Info links and the copyright holder. Reads need NRMS.SiteEditor or Core.Admin;
 * writes NRMS.SiteEditor.
 */
export function FooterScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-footer">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the footer links.</p>
      </div>
    );
  }
  return <FooterFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function FooterFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"footer">("footer", {
    fromDocument: (footer) => footer,
    toRequest: (footer) => ({
      ...footer,
      helpLinks: withoutBlankLinks(footer.helpLinks),
      connectLinks: withoutBlankLinks(footer.connectLinks),
      moreInfoLinks: withoutBlankLinks(footer.moreInfoLinks),
    }),
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
    const message = fieldErrors.find((e) => e.field === `footer.${field}`)?.message;
    return { errorMessage: message, isInvalid: message !== undefined };
  };
  const set = (patch: Partial<FooterSettings>) => editor.setValue((v) => ({ ...v, ...patch }));
  // The public site shows the year in the tenant's zone; this hint is only a sample of the wording.
  const year = formatInZone(new Date(), timeZone, { year: "numeric" }, "en-CA");

  return (
    <div className="gcpe-site-footer">
      <h1>{TITLE}</h1>

      <TextArea label="Help text" value={value.helpText} onChange={(helpText) => set({ helpText })} isDisabled={!canEdit} {...errorOf("helpText")} />
      {LISTS.map(({ field, legend }) => (
        <LinkListEditor
          key={field}
          legend={legend}
          links={value[field]}
          onChange={(links) => set({ [field]: links })}
          errors={fieldErrors}
          pathPrefix={`footer.${field}`}
          reorderable
          withSummary={false}
          isDisabled={!canEdit}
        />
      ))}
      <TextField
        label="Copyright holder"
        description={`Shows as “© ${year} ${value.copyrightHolder}”`}
        value={value.copyrightHolder}
        onChange={(copyrightHolder) => set({ copyrightHolder })}
        isDisabled={!canEdit}
        {...errorOf("copyrightHolder")}
      />
      <TextArea
        label="Land acknowledgement"
        description="Shown in a band above the footer on every page. Plain text. Leave it empty to hide the band."
        value={value.landAcknowledgement ?? ""}
        onChange={(landAcknowledgement) => set({ landAcknowledgement })}
        isDisabled={!canEdit}
        {...errorOf("landAcknowledgement")}
      />

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="footer" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
