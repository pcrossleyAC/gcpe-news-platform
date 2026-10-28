import { Checkbox, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { LABEL_KEYS, LISTING_KINDS, type LabelKey, type ListingKind, type NavigationSettings } from "@gcpe/site-settings";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { LinkListEditor, withoutBlankLinks } from "../../../shared/LinkListEditor";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { ConflictPanel } from "./ConflictPanel";
import { OtherSectionErrors } from "./OtherSectionErrors";
import { PublishBar } from "./PublishBar";
import { useSettingsEditor, type SettingsEditor } from "./useSettingsEditor";

const TITLE = "Navigation and labels";

export const INTRO =
  "The menu, button and heading wording used across the public site. The news menu label, the webcast button label, every page label and every listing title are required. The footer headings are optional.";

export const HEADER_LINKS_HINT = "Shown in the header after the news menu. Up to 4 links.";

const HEADER_LINKS_MAX = 4;

/** The label of each page-label box, from its key and what it is on the public site. */
export const LABEL_FIELDS: Record<LabelKey, string> = {
  connectWithUs: "Connect With Us heading",
  viewAllSocialMedia: "View all social media link label",
  resources: "Resources heading",
  newsBySector: "News by Sector heading",
  emergencyInformation: "Emergency information heading",
  highlights: "Highlights heading",
  latestNews: "Latest news heading",
  loadMoreNews: "Load more news button label",
  searchNews: "Search news heading",
  browseMoreNews: "Browse more news link label",
  slideActionLabel: "Slide link label (when a slide has none)",
};

const LISTING_FIELDS: Record<ListingKind, string> = {
  releases: "Releases page title",
  stories: "Stories page title",
  factsheets: "Factsheets page title",
  updates: "Updates page title",
};

/**
 * `/hub/website/navigation`: the public site's header (menu and button labels, header links, the
 * search box), footer headings, page labels and the per-kind listing titles. Reads need
 * NRMS.SiteEditor or Core.Admin; writes NRMS.SiteEditor.
 */
export function NavigationScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-navigation">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the navigation and labels.</p>
      </div>
    );
  }
  return <NavigationFields canEdit={session.has("NRMS.SiteEditor")} />;
}

function NavigationFields({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const editor = useSettingsEditor<"navigation">("navigation", {
    fromDocument: (navigation) => navigation,
    // Blank header-link rows are dropped before sending; the hook then shows the saved document,
    // so the form's rows (and every error index) match what the server checked.
    toRequest: (navigation) => ({ ...navigation, headerLinks: withoutBlankLinks(navigation.headerLinks) }),
  });
  const { value, state, fieldErrors } = editor;

  if (editor.loadError) {
    return (
      <div className="gcpe-site-navigation">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={editor.loadError} />
      </div>
    );
  }
  if (!value || !state) {
    return (
      <div className="gcpe-site-navigation">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const errorOf = (field: string) => {
    const message = fieldErrors.find((e) => e.field === `navigation.${field}`)?.message;
    return { errorMessage: message, isInvalid: message !== undefined };
  };
  const set = (patch: Partial<NavigationSettings>) => editor.setValue((v) => ({ ...v, ...patch }));
  const text = (field: string, label: string, current: string, apply: (v: string) => void) => (
    <TextField label={label} value={current} onChange={apply} isDisabled={!canEdit} {...errorOf(field)} />
  );

  return (
    <div className="gcpe-site-navigation">
      <h1>{TITLE}</h1>
      <p>{INTRO}</p>

      <fieldset>
        <legend>Header</legend>
        {text("newsLabel", "News menu label", value.newsLabel, (newsLabel) => set({ newsLabel }))}
        {text("liveLabel", "Live webcast button label", value.liveLabel, (liveLabel) => set({ liveLabel }))}
        <LinkListEditor
          legend="Header links"
          description={HEADER_LINKS_HINT}
          links={value.headerLinks}
          onChange={(headerLinks) => set({ headerLinks })}
          errors={fieldErrors}
          pathPrefix="navigation.headerLinks"
          reorderable
          withSummary={false}
          maxLinks={HEADER_LINKS_MAX}
          isDisabled={!canEdit}
        />
        <Checkbox isSelected={value.showHeaderSearch} onChange={(showHeaderSearch) => set({ showHeaderSearch })} isDisabled={!canEdit}>
          Show the search box in the header
        </Checkbox>
      </fieldset>

      <fieldset>
        <legend>Footer headings</legend>
        {text("footerConnectHeading", "Connect with Us column heading", value.footerConnectHeading, (footerConnectHeading) => set({ footerConnectHeading }))}
        {text("footerMoreInfoHeading", "More Info column heading", value.footerMoreInfoHeading, (footerMoreInfoHeading) => set({ footerMoreInfoHeading }))}
      </fieldset>

      <fieldset>
        <legend>Page labels</legend>
        {LABEL_KEYS.map((key) => (
          <TextField
            key={key}
            label={LABEL_FIELDS[key]}
            value={value.labels[key]}
            onChange={(v) => set({ labels: { ...value.labels, [key]: v } })}
            isDisabled={!canEdit}
            {...errorOf(`labels.${key}`)}
          />
        ))}
      </fieldset>

      <fieldset>
        <legend>Listing titles</legend>
        {LISTING_KINDS.map((kind) => (
          <TextField
            key={kind}
            label={LISTING_FIELDS[kind]}
            value={value.listingTitles[kind]}
            onChange={(v) => set({ listingTitles: { ...value.listingTitles, [kind]: v } })}
            isDisabled={!canEdit}
            {...errorOf(`listingTitles.${kind}`)}
          />
        ))}
      </fieldset>

      <OtherSectionErrors errors={editor.otherErrors} />
      <ConflictPanel editor={editor as SettingsEditor<unknown>} section="navigation" timeZone={timeZone} />
      <PublishBar editor={editor as SettingsEditor<unknown>} canEdit={canEdit} timeZone={timeZone} />
    </div>
  );
}
