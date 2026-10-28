import { contrastRatio } from "./contrast";
import { LABEL_KEYS, LISTING_KINDS, NETWORKS, MINISTRY_PAGE_LABEL_KEYS, THEME_COLOR_KEYS } from "./model";
import type { FieldError, LinkSetting, SiteSettings } from "./model";
import { isSafeUrl } from "./urls";

const MIN_CONTRAST = 4.5;
const BANNER_MAX = 300;
const HELP_TEXT_MAX = 200;
const LAND_ACK_MAX = 1000;
const SUMMARY_MAX = 200;
const HEADING_MAX = 60;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const LINK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/**
 * Ids the public pages (header.ts, render.ts) and site.js (site-script.ts) own. A link id that
 * repeats one would give the page a duplicate id and let site.js bind to the wrong element, so
 * they are refused. Keep in step with those files when they gain a fixed id.
 */
const RESERVED_LINK_IDS: ReadonlySet<string> = new Set([
  "live-button", "live-status", "news-dropdown", "menu", "ministry-dropdown", "search-md-button", "smd-search-container",
  "mini-site-search-input", "site-search-input", "main-nav", "main-nav-container", "BCGov-logo", "sm-BCGov-logo",
  "banner-toggle-sm", "nav-menu-sm", "sm-nav-container", "navbarSupportedContent", "sm-nav-ul", "bannerToggleLink",
  "main", "main-content", "banner", "site-banner", "bridge-banner", "btnCloseBannerBridge", "landAcknowledgement",
  "footer", "BCGov-logo-footer", "carousel-holder", "btnCloseBanner", "not-found-q", "main-content-release", "live-consent",
  "emergency-heading",
]);
const NAV_LABEL_MAX = 40;
const SHORT_TEXT_MAX = 100;
const LONG_HEADING_MAX = 200;
const LINK_TEXT_MAX = 200;
const INTRO_MAX = 300;
const NOT_FOUND_TEXT_MAX = 300;
const LICENCE_TEXT_MAX = 200;
const LICENCE_LINK_TEXT_MAX = 100;
const HTML_MAX = 50_000;
const CONTACT_FIELD_MAX = 100;
const PHONE_MAX = 50;
const HEADER_LINKS_MAX = 4;
const CONTACTS_MAX = 30;
const ARCHIVE_LINKS_MAX = 10;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UNSAFE_URL = "Must start with https:// or / (a page on this site).";
const hasMarkup = (s: string) => s.includes("<") || s.includes(">");

/** One text field's rules, at most one error (the first that fails): required, plain text, length. */
function checkText(field: string, value: string, rules: { max: number; required?: boolean; plain?: boolean }, errors: FieldError[]): void {
  if (rules.required && value.trim() === "") errors.push({ field, message: "Enter text for this field." });
  else if (rules.plain !== false && hasMarkup(value)) errors.push({ field, message: "Use plain text." });
  else if (value.length > rules.max) errors.push({ field, message: `Keep it to ${rules.max} characters or fewer.` });
}

function checkListSize(field: string, list: unknown[], max: number, errors: FieldError[]): void {
  if (list.length > max) errors.push({ field, message: `Keep the list to ${max} or fewer.` });
}

/** A link that may be left out: all of `text` and `url` empty, or text plus a safe URL. */
function checkOptionalLink(at: string, link: { text: string; url: string }, textKey: string, errors: FieldError[]): void {
  if (link.text === "" && link.url === "") return;
  if (link.text.trim() === "") errors.push({ field: `${at}.${textKey}`, message: "Enter the link text." });
  if (!isSafeUrl(link.url)) errors.push({ field: `${at}.url`, message: UNSAFE_URL });
}

function validateLinks(field: string, links: LinkSetting[], errors: FieldError[]): void {
  links.forEach((link, i) => {
    const at = `${field}[${i}]`;
    if (link.text.trim() === "") errors.push({ field: `${at}.text`, message: "Enter the link text." });
    else checkText(`${at}.text`, link.text, { max: LINK_TEXT_MAX }, errors);
    if (!isSafeUrl(link.url)) errors.push({ field: `${at}.url`, message: UNSAFE_URL });
    if (link.summary !== undefined && (link.summary.length > SUMMARY_MAX || hasMarkup(link.summary))) {
      errors.push({ field: `${at}.summary`, message: `Use plain text, ${SUMMARY_MAX} characters or fewer.` });
    }
    if (link.id !== undefined && !LINK_ID.test(link.id)) {
      errors.push({ field: `${at}.id`, message: "Link id must start with a letter and use only letters, digits, - or _." });
    } else if (link.id !== undefined && RESERVED_LINK_IDS.has(link.id)) {
      errors.push({ field: `${at}.id`, message: `The id "${link.id}" is used by the site itself. Choose a different link id.` });
    }
  });
}

function checkContrast(field: string, fg: string, bg: string, where: string, errors: FieldError[]): void {
  const ratio = contrastRatio(fg, bg);
  if (ratio < MIN_CONTRAST) {
    errors.push({ field, message: `Too faint to read ${where} (${ratio.toFixed(1)}:1, needs ${MIN_CONTRAST}:1). Pick a darker shade.` });
  }
}

/** Every rule a settings document must pass before it can be published. */
export function validateSiteSettings(doc: SiteSettings): FieldError[] {
  const errors: FieldError[] = [];

  const b = doc.banner;
  if (b.style !== "info" && b.style !== "emergency") errors.push({ field: "banner.style", message: "Choose Information or Emergency." });
  if (b.enabled && b.message.trim() === "") errors.push({ field: "banner.message", message: "Enter a message, or turn the banner off." });
  if (b.message.length > BANNER_MAX) errors.push({ field: "banner.message", message: `Keep the message to ${BANNER_MAX} characters or fewer.` });
  if (hasMarkup(b.message)) errors.push({ field: "banner.message", message: "Use plain text. Add links below instead of HTML." });
  if (b.startsAt !== null && b.endsAt !== null && Date.parse(b.endsAt) <= Date.parse(b.startsAt)) {
    errors.push({ field: "banner.endsAt", message: "The end time must be after the start time." });
  }
  validateLinks("banner.links", b.links, errors);

  const c = doc.theme.colors;
  let allValid = true;
  for (const key of THEME_COLOR_KEYS) {
    if (!HEX.test(c[key])) {
      errors.push({ field: `theme.colors.${key}`, message: "Use a colour like #013366." });
      allValid = false;
    }
  }
  if (allValid) {
    checkContrast("theme.colors.text", c.text, c.background, "on the page background", errors);
    checkContrast("theme.colors.surface", c.text, c.surface, "on panels", errors);
    checkContrast("theme.colors.primaryText", c.primaryText, c.primary, "on the header", errors);
    // P7: --theme-link aliases --color-primary, so the primary colour is also every link's colour.
    checkContrast("theme.colors.primary", c.primary, c.background, "as link text", errors);
    // Legacy CSS also paints hard-coded white text on it (custom.css .btn-primary-blue, site.css
    // .news-listing .home-body h3), whatever primaryText or the background are.
    checkContrast("theme.colors.primary", "#FFFFFF", c.primary, "behind white text", errors);
    checkContrast("theme.colors.bannerInfo", "#FFFFFF", c.bannerInfo, "behind white text", errors);
    checkContrast("theme.colors.bannerEmergency", "#FFFFFF", c.bannerEmergency, "behind white text", errors);
  }

  const f = doc.footer;
  validateLinks("footer.helpLinks", f.helpLinks, errors);
  validateLinks("footer.connectLinks", f.connectLinks, errors);
  validateLinks("footer.moreInfoLinks", f.moreInfoLinks, errors);
  if (f.copyrightHolder.trim() === "") errors.push({ field: "footer.copyrightHolder", message: "Enter who holds the copyright." });
  if (f.helpText.length > HELP_TEXT_MAX) errors.push({ field: "footer.helpText", message: `Keep the help text to ${HELP_TEXT_MAX} characters or fewer.` });
  if (hasMarkup(f.helpText)) errors.push({ field: "footer.helpText", message: "Use plain text." });
  // Trimmed, as the public site shows it: whitespace-only is empty (no band, render.ts) and
  // surrounding whitespace doesn't count toward the limit.
  const ack = (f.landAcknowledgement ?? "").trim();
  if (ack.length > LAND_ACK_MAX) errors.push({ field: "footer.landAcknowledgement", message: `Keep the land acknowledgement to ${LAND_ACK_MAX} characters or fewer.` });
  if (hasMarkup(ack)) errors.push({ field: "footer.landAcknowledgement", message: "Use plain text." });

  for (const { key } of NETWORKS) {
    validateLinks(`connect.${key}.featured`, doc.connect[key].featured, errors);
    validateLinks(`connect.${key}.accounts`, doc.connect[key].accounts, errors);
  }

  validateConnectExtras(doc, errors);

  for (const key of MINISTRY_PAGE_LABEL_KEYS) {
    const label = doc.ministryPages[key];
    if (label.trim() === "") errors.push({ field: `ministryPages.${key}`, message: "Enter a heading." });
    else if (label.length > HEADING_MAX || hasMarkup(label)) {
      errors.push({ field: `ministryPages.${key}`, message: `Use plain text, ${HEADING_MAX} characters or fewer.` });
    }
  }

  validateContactsPage(doc.contactsPage, errors);
  validatePageText(doc.pageText, errors);
  validateNavigation(doc.navigation, errors);

  return errors;
}

function validateConnectExtras(doc: SiteSettings, errors: FieldError[]): void {
  const { policyLink, intro } = doc.connect;
  checkOptionalLink("connect.policyLink", policyLink, "text", errors);
  checkText("connect.policyLink.text", policyLink.text, { max: LONG_HEADING_MAX }, errors);
  checkText("connect.intro", intro, { max: INTRO_MAX }, errors);
}

function validateContactsPage(p: SiteSettings["contactsPage"], errors: FieldError[]): void {
  checkText("contactsPage.heading", p.heading, { max: SHORT_TEXT_MAX, required: true }, errors);
  checkText("contactsPage.lineHeading", p.lineHeading, { max: SHORT_TEXT_MAX }, errors);
  checkText("contactsPage.listHeading", p.listHeading, { max: SHORT_TEXT_MAX }, errors);
  checkText("contactsPage.introHtml", p.introHtml, { max: HTML_MAX, plain: false }, errors);
  checkListSize("contactsPage.contacts", p.contacts, CONTACTS_MAX, errors);
  p.contacts.forEach((c, i) => {
    const at = `contactsPage.contacts[${i}]`;
    checkText(`${at}.group`, c.group, { max: CONTACT_FIELD_MAX, required: true }, errors);
    checkText(`${at}.subgroup`, c.subgroup, { max: CONTACT_FIELD_MAX }, errors);
    checkText(`${at}.name`, c.name, { max: CONTACT_FIELD_MAX, required: true }, errors);
    checkText(`${at}.phone`, c.phone, { max: PHONE_MAX }, errors);
    checkText(`${at}.cell`, c.cell, { max: PHONE_MAX }, errors);
    if (c.groupUrl !== "" && !isSafeUrl(c.groupUrl)) errors.push({ field: `${at}.groupUrl`, message: UNSAFE_URL });
    else checkText(`${at}.groupUrl`, c.groupUrl, { max: CONTACT_FIELD_MAX }, errors);
    if (c.email !== "" && !EMAIL.test(c.email)) errors.push({ field: `${at}.email`, message: "Enter an email address like name@gov.bc.ca." });
    else checkText(`${at}.email`, c.email, { max: CONTACT_FIELD_MAX }, errors);
    if (c.placement !== "top" && c.placement !== "bottom") errors.push({ field: `${at}.placement`, message: "Choose Top or Bottom." });
  });
}

function validatePageText(t: SiteSettings["pageText"], errors: FieldError[]): void {
  checkText("pageText.notFound.heading", t.notFound.heading, { max: LONG_HEADING_MAX, required: true }, errors);
  checkText("pageText.notFound.text", t.notFound.text, { max: NOT_FOUND_TEXT_MAX }, errors);
  checkText("pageText.privacy.label", t.privacy.label, { max: HEADING_MAX }, errors);
  checkText("pageText.privacy.title", t.privacy.title, { max: LONG_HEADING_MAX, required: true }, errors);
  checkText("pageText.privacy.bodyHtml", t.privacy.bodyHtml, { max: HTML_MAX, plain: false }, errors);
  checkText("pageText.live.heading", t.live.heading, { max: HEADING_MAX }, errors);
  checkText("pageText.live.consentHtml", t.live.consentHtml, { max: HTML_MAX, plain: false }, errors);
  checkText("pageText.live.offAirHtml", t.live.offAirHtml, { max: HTML_MAX, plain: false }, errors);
  checkText("pageText.collectionNotice.heading", t.collectionNotice.heading, { max: SHORT_TEXT_MAX }, errors);
  checkText("pageText.collectionNotice.bodyHtml", t.collectionNotice.bodyHtml, { max: HTML_MAX, plain: false }, errors);
  checkText("pageText.subscribeHelpHtml", t.subscribeHelpHtml, { max: HTML_MAX, plain: false }, errors);
  const lic = t.assetLicence;
  if (lic.text !== "" || lic.linkText !== "" || lic.url !== "") {
    if (lic.linkText.trim() === "") errors.push({ field: "pageText.assetLicence.linkText", message: "Enter the link text." });
    if (!isSafeUrl(lic.url)) errors.push({ field: "pageText.assetLicence.url", message: UNSAFE_URL });
  }
  checkText("pageText.assetLicence.text", lic.text, { max: LICENCE_TEXT_MAX }, errors);
  checkText("pageText.assetLicence.linkText", lic.linkText, { max: LICENCE_LINK_TEXT_MAX }, errors);
  checkListSize("pageText.searchArchiveLinks", t.searchArchiveLinks, ARCHIVE_LINKS_MAX, errors);
  validateLinks("pageText.searchArchiveLinks", t.searchArchiveLinks, errors);
}

function validateNavigation(n: SiteSettings["navigation"], errors: FieldError[]): void {
  checkText("navigation.newsLabel", n.newsLabel, { max: NAV_LABEL_MAX, required: true }, errors);
  checkText("navigation.liveLabel", n.liveLabel, { max: NAV_LABEL_MAX, required: true }, errors);
  checkText("navigation.footerConnectHeading", n.footerConnectHeading, { max: HEADING_MAX }, errors);
  checkText("navigation.footerMoreInfoHeading", n.footerMoreInfoHeading, { max: HEADING_MAX }, errors);
  for (const key of LABEL_KEYS) checkText(`navigation.labels.${key}`, n.labels[key], { max: HEADING_MAX, required: true }, errors);
  for (const kind of LISTING_KINDS) checkText(`navigation.listingTitles.${kind}`, n.listingTitles[kind], { max: HEADING_MAX, required: true }, errors);
  checkListSize("navigation.headerLinks", n.headerLinks, HEADER_LINKS_MAX, errors);
  validateLinks("navigation.headerLinks", n.headerLinks, errors);
}
