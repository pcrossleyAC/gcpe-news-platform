import { contrastRatio } from "./contrast";
import { NETWORKS, MINISTRY_PAGE_LABEL_KEYS, THEME_COLOR_KEYS } from "./model";
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
const hasMarkup = (s: string) => s.includes("<") || s.includes(">");

function validateLinks(field: string, links: LinkSetting[], errors: FieldError[]): void {
  links.forEach((link, i) => {
    const at = `${field}[${i}]`;
    if (link.text.trim() === "") errors.push({ field: `${at}.text`, message: "Enter the link text." });
    if (!isSafeUrl(link.url)) errors.push({ field: `${at}.url`, message: "Must start with https:// or / (a page on this site)." });
    if (link.summary !== undefined && (link.summary.length > SUMMARY_MAX || hasMarkup(link.summary))) {
      errors.push({ field: `${at}.summary`, message: `Use plain text, ${SUMMARY_MAX} characters or fewer.` });
    }
    if (link.id !== undefined && !LINK_ID.test(link.id)) {
      errors.push({ field: `${at}.id`, message: "Link id must start with a letter and use only letters, digits, - or _." });
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

  for (const key of MINISTRY_PAGE_LABEL_KEYS) {
    const label = doc.ministryPages[key];
    if (label.trim() === "") errors.push({ field: `ministryPages.${key}`, message: "Enter a heading." });
    else if (label.length > HEADING_MAX || hasMarkup(label)) {
      errors.push({ field: `ministryPages.${key}`, message: `Use plain text, ${HEADING_MAX} characters or fewer.` });
    }
  }

  return errors;
}
