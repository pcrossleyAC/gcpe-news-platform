import type { DirectoryContact } from "@gcpe/site-settings";
import type { MinistryContactDto } from "../dto";
import { e, safeHref } from "../render";

/** Only non-empty strings are ever read from a contact (it comes over the wire), each escaped. */
export function contactValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A contact email as a mailto link when safeHref accepts it (as the minister card's email), else as text. */
export function mailtoLink(email: string): string {
  const href = safeHref(`mailto:${email}`);
  return href ? `<a href="${e(href)}">${e(email)}</a>` : e(email);
}

/**
 * One contact, as legacy's CommContact partial renders it: name, "Direct: <phone>" and
 * "Cell: <mobile>" in a div (a `<br>` between them only when both exist; no div when neither),
 * then the email as a mailto link (plain text when it isn't a safe mailto). Empty when the
 * contact has no field at all. Shared by the ministry page's Media Contacts and `/contacts/`.
 */
export function commContact(c: MinistryContactDto | null | undefined): string {
  if (!c || typeof c !== "object") return "";
  const name = contactValue(c.fullName);
  const phone = contactValue(c.phoneNumber);
  const mobile = contactValue(c.mobileNumber);
  const email = contactValue(c.emailAddress);
  if ([name, phone, mobile, email].every((v) => v === undefined)) return "";
  const numbers = [phone !== undefined ? `<span>Direct: ${e(phone)}</span>` : "", mobile !== undefined ? `<span>Cell: ${e(mobile)}</span>` : ""].filter(Boolean);
  return [
    name !== undefined ? `<span class="contact-name">${e(name)}</span>` : "",
    numbers.length ? `<div>${numbers.join("<br>")}</div>` : "",
    email !== undefined ? `${mailtoLink(email)}<br>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A Media contacts page settings row as the CommContact shape (blanks as null). */
export function directoryContact(c: Pick<DirectoryContact, "name" | "phone" | "cell" | "email">): MinistryContactDto {
  const v = (s: string) => contactValue(s) ?? null;
  return { fullName: v(c.name), phoneNumber: v(c.phone), mobileNumber: v(c.cell), emailAddress: v(c.email) };
}
