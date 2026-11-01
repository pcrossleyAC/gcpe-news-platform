import { CALENDAR_ROLE_INFO } from "../calendar-access/calendar-roles";
import { roleBadge } from "../users/roles";

/** One entry of Core's admin audit trail, as `GET /core/api/audit` sends it (apps/core/src/services/audit.ts). */
export interface AuditEntry {
  id: number;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  targetType: "user" | "organization" | "term" | "cabinet-change" | "core";
  targetId: string;
  targetLabel: string;
  details: Record<string, unknown>;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** "A", "A and B", "A, B and C". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const fromTo = (v: unknown): { from: unknown; to: unknown } | null => (v && typeof v === "object" && "to" in v ? (v as { from: unknown; to: unknown }) : null);
const text = (v: unknown) => (typeof v === "string" && v ? v : "none");

/** The Organizations form's own names for the fields an edit can change. */
const ORG_FIELDS: Record<string, string> = {
  displayAdditionalName: "additional display name",
  sortOrder: "sort order",
  parentKey: "parent ministry",
  minister: "minister",
  contact: "primary contact",
  secondContact: "alternate contact",
  weekendContactNumber: "after-hours phone",
  url: "ministry website",
  social: "Flickr or YouTube address",
  topicLinks: "Featured Topics",
  serviceLinks: "Featured Services",
  teamLinks: "Meet the Team links",
  sectorKeys: "sectors",
  isHq: "HQ setting",
  isPublic: "public setting",
};

const TERM_KINDS: Record<string, string> = { sector: "sector", theme: "theme", tag: "tag", service: "service" };

const VIA: Record<string, string> = { "cabinet-change": " (cabinet change)", "hand-over": " (hand-over)" };

const changes = (n: unknown) => (typeof n === "number" ? ` (${n} ${n === 1 ? "change" : "changes"})` : "");

/**
 * What an entry did, as the rest of a sentence that starts with who did it: "gave Core Admin to
 * Jo Lee". Names are as they were at the time. `orgName` turns a ministry key into its name (the
 * key itself when it is unknown); `when` writes an instant in BC time (format/dates.ts).
 */
export function describeEntry(e: AuditEntry, orgName: (key: string) => string | undefined = () => undefined, when?: (iso: string) => string): string {
  const d = e.details;
  const who = e.targetLabel;
  const ministry = (k: string) => orgName(k) ?? k;
  const via = typeof d.via === "string" ? (VIA[d.via] ?? "") : "";
  switch (e.action) {
    case "user.created": {
      const roles = strings(d.roles).map(roleBadge);
      const email = typeof d.email === "string" ? ` (${d.email})` : "";
      return `added ${who}${email} with ${roles.length ? list(roles) : "no roles"}`;
    }
    case "user.renamed":
      return `renamed ${text(d.from)} to ${text(d.to)}`;
    case "user.activated":
      return `reactivated ${who}`;
    case "user.deactivated":
      return `deactivated ${who}`;
    case "user.roles": {
      const added = strings(d.added).map(roleBadge);
      const removed = strings(d.removed).map(roleBadge);
      if (added.length && removed.length) return `gave ${list(added)} to ${who}, and took ${list(removed)} from them`;
      if (added.length) return `gave ${list(added)} to ${who}`;
      return `took ${list(removed)} from ${who}`;
    }
    case "user.password-set":
      return `set a new password for ${who}`;
    case "user.linked":
      return `linked ${who} to ${text(d.email)} and activated them`;
    case "user.microsoft-linked":
      return "signed in with Microsoft for the first time, which linked their account";
    case "user.microsoft-unlinked":
      return `unlinked ${who} from Microsoft sign-in`;
    case "calendar.access": {
      const parts: string[] = [];
      const role = fromTo(d.role);
      const label = (r: unknown) => CALENDAR_ROLE_INFO.find((i) => i.role === r)?.label ?? String(r);
      if (role && role.from === null) parts.push(`gave them the ${label(role.to)} role`);
      else if (role && role.to === null) parts.push(`took away their ${label(role.from)} role`);
      else if (role) parts.push(`changed their role from ${label(role.from)} to ${label(role.to)}`);
      if (strings(d.added).length) parts.push(`added ${list(strings(d.added).map(ministry))}`);
      if (strings(d.removed).length) parts.push(`removed ${list(strings(d.removed).map(ministry))}`);
      return `changed ${who}'s Calendar access: ${parts.join("; ")}`;
    }
    case "org.created":
      return `added ${who}${via}`;
    case "org.edited": {
      const parts: string[] = [];
      const name = fromTo(d.name);
      const abbreviation = fromTo(d.abbreviation);
      const active = fromTo(d.active);
      if (name) parts.push(`renamed ${text(name.from)} to ${text(name.to)}`);
      if (abbreviation) parts.push(`changed the abbreviation of ${who} from ${text(abbreviation.from)} to ${text(abbreviation.to)}`);
      if (active) parts.push(`${active.to ? "reactivated" : "deactivated"} ${who}`);
      const fields = strings(d.fields).map((f) => ORG_FIELDS[f] ?? f);
      if (fields.length) parts.push(`changed ${who}'s ${list(fields)}`);
      return `${parts.length ? parts.join("; ") : `changed ${who}`}${via}`;
    }
    case "org.hq":
      return `made ${who} ${d.isHq ? "an HQ organization" : "no longer an HQ organization"}${via}`;
    case "org.public":
      return `made ${who} ${d.isPublic ? "public" : "not public"}${via}`;
    case "org.deactivated":
      return `deactivated ${who}${via}`;
    case "org.handed-over": {
      const successors = Array.isArray(d.successors) ? d.successors.map((s: { key?: string; name?: string }) => s.name ?? ministry(s.key ?? "")) : [];
      const moved = typeof d.staffMoved === "number" && d.staffMoved > 0 ? ` (${d.staffMoved} staff moved)` : "";
      return `handed ${who} over to ${list(successors)}${moved}${via}`;
    }
    case "term.created":
    case "term.edited":
    case "term.deactivated": {
      const kind = TERM_KINDS[String(d.kind)] ?? "entry";
      if (e.action === "term.created") return `added the ${kind} ${who}`;
      if (e.action === "term.deactivated") return `deactivated the ${kind} ${who}`;
      const parts: string[] = [];
      const name = fromTo(d.name);
      const active = fromTo(d.active);
      if (name) parts.push(`renamed the ${kind} ${text(name.from)} to ${text(name.to)}`);
      if (active) parts.push(`${active.to ? "reactivated" : "deactivated"} the ${kind} ${who}`);
      if (parts.length) return parts.join("; ");
      if (strings(d.fields).length === 1 && strings(d.fields)[0] === "sortOrder") return `changed the order of the ${kind} ${who}`;
      return `changed the ${kind} ${who}`;
    }
    case "cabinet.saved":
      return `saved the cabinet change draft${changes(d.operations)}`;
    case "cabinet.scheduled":
      return when && typeof d.at === "string" ? `scheduled the cabinet change for ${when(d.at)}` : "scheduled the cabinet change";
    case "cabinet.cancelled":
      return "cancelled the cabinet change";
    case "cabinet.published":
      return `published the cabinet change${changes(d.operations)}`;
    case "core.republished":
      return `sent every ministry, user, sector, theme and tag to the other apps again${typeof d.enqueued === "number" ? ` (${d.enqueued} records)` : ""}`;
    default:
      return `changed ${who}`;
  }
}
