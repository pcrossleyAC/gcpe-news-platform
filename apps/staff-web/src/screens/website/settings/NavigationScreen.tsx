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

/** The label of each page-label box, from what it is on the public site. */
export const LABEL_FIELDS: Record<LabelKey, string> = {
  connectWithUs: "Home page: Connect With Us heading",
  viewAllSocialMedia: "View all social media link label",
  resources: "Resources heading",
  newsBySector: "News by Sector heading",
  emergencyInformation: "Emergency information heading",
  highlights: "Slideshow name (read aloud by screen readers)",
  latestNews: "Home page main heading (hidden, for screen readers)",
  loadMoreNews: "Load more news button label",
  searchNews: "Search news link label",
  browseMoreNews: "Browse more news link label",
  slideActionLabel: "Slide link label (when a slide has none)",
};

/** Where each page label appears; one per key, so adding a key without a hint fails to compile. */
export const LABEL_HINTS: Record<LabelKey, string> = {
  connectWithUs: "Heading above the social links on the home page.",
  viewAllSocialMedia: "Link under the social links on the home page that opens the Connect page.",
  resources: "Heading above the resource links on the home page.",
  newsBySector: "Heading above the sector list on the home page.",
  emergencyInformation: "Heading above emergency notices on the home page. Shown only when a notice is active.",
  highlights: "Not shown on screen. Screen readers announce it for the slideshow at the top of the home page.",
  latestNews: "Not visible on the page. Screen readers and search engines read it as the home page's main heading.",
  loadMoreNews: "Button under the news cards on the home page and ministry pages.",
  searchNews: "The link under the news list that opens the search page.",
  browseMoreNews: "Link under the news list on category pages.",
  slideActionLabel: "Link text on a home page slide or emergency notice that has no link text of its own.",
};

const LISTING_FIELDS: Record<ListingKind, string> = {
  releases: "Releases page title",
  stories: "Stories page title",
  factsheets: "Factsheets page title",
  updates: "Updates page title",
};

export const LISTING_HINTS: Record<ListingKind, string> = {
  releases: "Title of the /releases/ page.",
  stories: "Title of the /stories/ page.",
  factsheets: "Title of the /factsheets/ page.",
  updates: "Title of the /updates/ page.",
};

export const FOOTER_CONNECT_HINT = "Heading of the first (left) column in the page footer. Leave blank to show no heading. The column appears only when it has links on the Footer screen.";
export const FOOTER_MORE_INFO_HINT = "Heading of the second (right) column in the page footer. Leave blank to show no heading. The column appears only when it has links on the Footer screen.";

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
  const text = (field: string, label: string, current: string, apply: (v: string) => void, description?: string) => (
    <TextField label={label} description={description} value={current} onChange={apply} isDisabled={!canEdit} {...errorOf(field)} />
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
        {text("footerConnectHeading", "Footer: Connect with Us column heading", value.footerConnectHeading, (footerConnectHeading) => set({ footerConnectHeading }), FOOTER_CONNECT_HINT)}
        {text("footerMoreInfoHeading", "Footer: More Info column heading", value.footerMoreInfoHeading, (footerMoreInfoHeading) => set({ footerMoreInfoHeading }), FOOTER_MORE_INFO_HINT)}
      </fieldset>

      <fieldset>
        <legend>Page labels</legend>
        {LABEL_KEYS.map((key) => (
          <TextField
            key={key}
            label={LABEL_FIELDS[key]}
            description={LABEL_HINTS[key]}
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
            description={LISTING_HINTS[kind]}
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
