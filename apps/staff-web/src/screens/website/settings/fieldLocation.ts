import { NETWORKS, type SectionKey } from "@gcpe/site-settings";
import { FIELDS as CONTACT_FIELDS } from "./DirectoryContactsEditor";
import { LISTS as FOOTER_LISTS } from "./FooterScreen";
import { FIELD_LABEL as MINISTRY_PAGE_FIELDS } from "./MinistryPagesScreen";
import { LABEL_FIELDS, LISTING_FIELDS } from "./NavigationScreen";

/**
 * Suite fix W2, fix round 1 (M2): where a settings value is on its screen, in the screen's own
 * legends and field labels ("Help links, link 2: Web address"), for Website > Hub address check.
 * `path` is the value's place in its section, as NRMS reports it. The label lists the screens
 * define are imported from them; the labels written inline in a screen's markup are repeated here
 * (with the screen named beside each). "" for a place this doesn't know, so the screen alone is shown.
 */

type Path = readonly (string | number)[];

/** A LinkListEditor row's fields (shared/LinkListEditor.tsx). */
const LINK_FIELD: Record<string, string> = { text: "Link text", url: "Web address", summary: "Description (optional)" };
const linkRow = (legend: string, path: Path): string => {
  const [index, field] = path;
  if (typeof index !== "number") return legend;
  const row = `${legend}, link ${index + 1}`;
  return typeof field === "string" && LINK_FIELD[field] ? `${row}: ${LINK_FIELD[field]}` : row;
};

/** Plain fields, by their path joined with "."; inline labels from each screen's markup. */
const FIELD: Partial<Record<SectionKey, Record<string, string>>> = {
  // BannerScreen.tsx
  banner: { message: "Message" },
  // FooterScreen.tsx
  footer: { helpText: "Help text", copyrightHolder: "Copyright holder", landAcknowledgement: "Land acknowledgement" },
  // SocialScreen.tsx
  connect: { "policyLink.text": "Policy link text", "policyLink.url": "Policy link URL", intro: "Introduction" },
  ministryPages: MINISTRY_PAGE_FIELDS,
  // MediaContactsScreen.tsx
  contactsPage: { heading: "Page heading", lineHeading: "Contact line heading", introHtml: "Introduction", listHeading: "List heading" },
  // PageTextScreen.tsx
  pageText: {
    "notFound.heading": "Page not found: Heading",
    "notFound.text": "Page not found: Text",
    "privacy.label": "Privacy page: Label",
    "privacy.title": "Privacy page: Title",
    "privacy.bodyHtml": "Privacy page: Statement",
    "live.heading": "Live webcast page: Heading",
    "live.consentHtml": "Live webcast page: Before play",
    "live.offAirHtml": "Live webcast page: When not live",
    "collectionNotice.heading": "Subscribe page: Notice heading",
    "collectionNotice.bodyHtml": "Subscribe page: Notice of Collection",
    subscribeHelpHtml: "Subscribe page: Help line",
    "assetLicence.text": "Media assets licence: Text",
    "assetLicence.linkText": "Media assets licence: Link text",
    "assetLicence.url": "Media assets licence: Link URL",
  },
  // NavigationScreen.tsx
  navigation: {
    newsLabel: "News menu label",
    liveLabel: "Live webcast button label",
    footerConnectHeading: "Footer: Connect with Us column heading",
    footerMoreInfoHeading: "Footer: More Info column heading",
    ...Object.fromEntries(Object.entries(LABEL_FIELDS).map(([k, v]) => [`labels.${k}`, v])),
    ...Object.fromEntries(Object.entries(LISTING_FIELDS).map(([k, v]) => [`listingTitles.${k}`, v])),
  },
  // SiteIdentityScreen.tsx
  siteIdentity: {
    description: "Site description",
    twitterSite: "X (Twitter) account",
    "blueBridge.message": "Project Blue Bridge banner: Banner message",
    "blueBridge.birthDate": "Project Blue Bridge banner: Birth date",
  },
};

/** Link lists (and the contacts list), by the key that holds them. */
function listLocation(section: SectionKey, path: Path): string | null {
  const [head, ...rest] = path;
  if (section === "banner" && head === "links") return linkRow("Links", rest);
  if (section === "footer") {
    const list = FOOTER_LISTS.find((l) => l.field === head);
    if (list) return linkRow(list.legend, rest);
  }
  if (section === "pageText" && head === "searchArchiveLinks") return linkRow("Search: older archives", rest);
  if (section === "navigation" && head === "headerLinks") return linkRow("Header links", rest);
  if (section === "connect") {
    const network = NETWORKS.find((n) => n.key === head);
    const [list, ...row] = rest;
    if (network && (list === "featured" || list === "accounts")) return `${network.name}: ${linkRow(list === "featured" ? "Featured accounts" : "Other accounts", row)}`;
  }
  if (section === "contactsPage" && head === "contacts") {
    const [index, field] = rest;
    if (typeof index !== "number") return "Other media contacts";
    const label = CONTACT_FIELDS.find((f) => f.key === field)?.label;
    return `Other media contacts, contact ${index + 1}${label ? `: ${label}` : ""}`;
  }
  return null;
}

export function settingsFieldLocation(section: SectionKey, path: Path): string {
  if (path.length === 0) return "";
  return listLocation(section, path) ?? FIELD[section]?.[path.join(".")] ?? "";
}
