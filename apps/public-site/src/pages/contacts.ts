import type { ContactsPageSettings, DirectoryContact } from "@gcpe/site-settings";
import type { MinistryContactDto, MinistryDto } from "../dto";
import { e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { sanitizeBodyHtml } from "../sanitize-body";
import { settingsHref } from "../settings";
import { categoryPageId, pageUrl, parsePageId } from "../site-paths";
import { commContact, contactValue, directoryContact } from "./comm-contact";

/** One directory row: the organisation cell's parts and the contacts, already in CommContact shape. */
interface ContactRow {
  name: string;
  href: string | null;
  /** Escaped `div`s under the name (the additional display name, the minister, a settings subgroup). */
  lines: string[];
  child: boolean;
  primary: MinistryContactDto;
  alternate: MinistryContactDto | null;
  afterHours: string | undefined;
}

function settingsRow(c: DirectoryContact, site: Pick<SiteInfo, "baseUrl">): ContactRow {
  const subgroup = contactValue(c.subgroup);
  return {
    name: c.group,
    href: contactValue(c.groupUrl) ? settingsHref(c.groupUrl.trim(), site) : null,
    lines: subgroup !== undefined ? [`<div>${e(subgroup)}</div>`] : [],
    child: false,
    primary: directoryContact(c),
    alternate: null,
    afterHours: undefined,
  };
}

function ministryRow(m: MinistryDto, child: boolean, site: Pick<SiteInfo, "baseUrl">): ContactRow {
  const id = categoryPageId("ministries", m.key);
  const page = id ? parsePageId(id) : null;
  const extra = contactValue(m.displayAdditionalName);
  const minister = contactValue(m.ministerName);
  return {
    name: m.name,
    href: page ? pageUrl(site, page) : null,
    lines: [extra !== undefined ? `<div><i>(${e(extra)})</i></div>` : "", minister !== undefined ? `<div>${e(minister)}</div>` : ""].filter(Boolean),
    child,
    primary: m.contactUser!,
    alternate: m.secondContactUser,
    afterHours: contactValue(m.weekendContactNumber),
  };
}

/**
 * Legacy lists every ministry with a ContactUser in the News API's (menu) order. Ours leaves out an
 * inactive ministry and one whose primary contact has nothing to show, and puts a child ministry
 * (parentMinistryKey) right after its parent, indented; a child whose parent isn't listed keeps its
 * place, not indented.
 */
export function directoryMinistries(ministries: MinistryDto[]): { ministry: MinistryDto; child: boolean }[] {
  const listed = ministries.filter((m) => m.isActive && commContact(m.contactUser) !== "");
  const keyOf = (k: string | null | undefined) => (k ?? "").toLowerCase();
  const keys = new Set(listed.map((m) => keyOf(m.key)));
  const isPlacedChild = (m: MinistryDto) => !!m.parentMinistryKey && keyOf(m.parentMinistryKey) !== keyOf(m.key) && keys.has(keyOf(m.parentMinistryKey));
  const out: { ministry: MinistryDto; child: boolean }[] = [];
  const seen = new Set<MinistryDto>();
  const place = (m: MinistryDto, child: boolean) => {
    if (seen.has(m)) return;
    seen.add(m);
    out.push({ ministry: m, child });
    for (const c of listed) if (isPlacedChild(c) && keyOf(c.parentMinistryKey) === keyOf(m.key)) place(c, true);
  };
  for (const m of listed) if (!isPlacedChild(m)) place(m, false);
  // A parent cycle (a → b → a) has no top-level member: still listed, in API order.
  for (const m of listed) place(m, false);
  return out;
}

const contactCell = (label: string, c: MinistryContactDto) => `<div class="col-xs-12 col-sm-4">
<span class="visually-hidden">${label} contact: </span>
${commContact(c)}
</div>`;

function renderRow(r: ContactRow): string {
  const name = r.href ? `<a href="${e(r.href)}">${e(r.name)}</a>` : `<span>${e(r.name)}</span>`;
  const alternate = r.alternate && commContact(r.alternate) ? `\n${contactCell("Alternate", r.alternate)}` : "";
  const afterHours = r.afterHours !== undefined ? `\n<div class="text-center after-hours">\n<div>\n<span><strong>After hours:</strong> ${e(r.afterHours)}</span>\n</div>\n</div>` : "";
  return `<div class="row contact-row">
<div class="col-xs-12 col-sm-4 contact-org${r.child ? " child" : ""}">
${[name, ...r.lines].join("\n")}
</div>
${contactCell("Primary", r.primary)}${alternate}${afterHours}
</div>`;
}

/**
 * Legacy Default/CommContacts.cshtml (H3), from the Media contacts page settings (T3) and each
 * ministry's media contacts. Plan-2 accessibility deviations: the legacy h3 title is the page's one
 * h1 and the h4s are h2s (overrides.css copies their metrics); the column headings are presentational
 * (aria-hidden, hidden on a phone as legacy) and each contact cell says which contact it is to a
 * screen reader; the intro is sanitised staff HTML (no target=_blank survives).
 */
export function renderContactsPage(ministries: MinistryDto[], cp: ContactsPageSettings, site: SiteInfo, opts: PageOptions = {}): string {
  const rows = [
    ...cp.contacts.filter((c) => c.placement === "top").map((c) => settingsRow(c, site)),
    ...directoryMinistries(ministries).map(({ ministry, child }) => ministryRow(ministry, child, site)),
    ...cp.contacts.filter((c) => c.placement === "bottom").map((c) => settingsRow(c, site)),
  ].filter((r) => contactValue(r.name) !== undefined && commContact(r.primary) !== "");
  const lineHeading = contactValue(cp.lineHeading);
  const listHeading = contactValue(cp.listHeading);
  const body = `<div class="comm-contacts">
<h1 class="comm-contacts-title">${e(cp.heading)}</h1>
<div class="clear"></div>
<div class="header">
${lineHeading !== undefined ? `<h2>${e(lineHeading)}</h2>\n` : ""}<div class="row">
<div class="col">
${sanitizeBodyHtml(cp.introHtml, { images: false })}
</div>
</div>
</div>
<div class="header">
${listHeading !== undefined ? `<h2>${e(listHeading)}</h2>` : ""}
</div>
<div class="row d-none d-md-flex contact-columns" aria-hidden="true">
<div class="col"></div>
<div class="col">Primary Contact</div>
<div class="col">Alternate Contact</div>
</div>
${rows.map(renderRow).join("\n")}
<div class="clear"></div>
</div>`;
  return renderPage(cp.heading, site, pageUrl(site, { type: "contacts" }), body, opts);
}
