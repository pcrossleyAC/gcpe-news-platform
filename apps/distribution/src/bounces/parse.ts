import { simpleParser, type ParsedMail } from "mailparser";

export type ParsedBounce =
  | { kind: "bounce"; recipient: string; status: string; hard: boolean; originalMessageId: string | null; method: "rfc3464" | "heuristic" }
  | { kind: "ignored"; reason: string };

// Legacy BounceManager.cs:60-67 (research-4e.md A.1), ported for the heuristic fallback:
// the enhanced-status-code form is tried first, then the bare 3-digit form — both anchored on
// the delimiter the legacy code required ("#", ";" or whitespace) immediately before the code,
// so a stray "45" or "5.1.1" elsewhere in the body (a date, a price) isn't mistaken for one.
const DOTTED_CODE = /[#;\s]([45]\.\d{1,3}\.\d{1,3})/;
const SHORT_CODE = /[#;\s]([45]\d{2})/;
const EMAIL_IN_BODY = /[\w.-]+@[\w.-]+/;
const UNDELIVERABLE_PREFIX = "Undeliverable:";

function isHard(code: string): boolean {
  return code.trim().startsWith("5");
}

/** A loose header-line block (no RFC 2231/folding support — the DSN/original-headers parts we
 * read here are short, machine-generated blocks; nothing in them needs it). Returns the first
 * value for each lowercased header name. */
function parseHeaderBlock(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const m = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.trim().toLowerCase();
    if (!fields.has(name)) fields.set(name, m[2]!.trim());
  }
  return fields;
}

/** Pulls the bare address out of a DSN address-type field ("rfc822;user@example.test", or
 * just the address on its own) — the type prefix is informational and not always present. */
function extractAddress(value: string): string | null {
  return EMAIL_IN_BODY.exec(value)?.[0] ?? null;
}

type DsnResult = { recipient: string; status: string } | null;

/** RFC 3464 §2's per-message/per-recipient block structure: fields separated by a blank line,
 * one block per recipient. Ours always has exactly one recipient (Distribution sends one
 * message per recipient), so the first block carrying both a recipient and a Status field is
 * the one we want. */
function parseDeliveryStatus(content: string): DsnResult {
  for (const block of content.split(/\r?\n\r?\n/)) {
    const fields = parseHeaderBlock(block);
    const status = fields.get("status");
    const recipientField = fields.get("final-recipient") ?? fields.get("original-recipient");
    if (!status || !recipientField) continue;
    const recipient = extractAddress(recipientField);
    if (!recipient) continue;
    return { recipient, status: status.trim() };
  }
  return null;
}

/** The original message's Message-ID, from the attached `message/rfc822` (full message) or
 * `text/rfc822-headers` (headers only) part — either way, only the headers at the top matter. */
function extractOriginalMessageId(content: string): string | null {
  const headerBlock = content.split(/\r?\n\r?\n/)[0] ?? "";
  return parseHeaderBlock(headerBlock).get("message-id") ?? null;
}

function isDeliveryStatusReport(mail: ParsedMail): boolean {
  const contentType = mail.headers.get("content-type") as { value?: string; params?: Record<string, string> } | undefined;
  return contentType?.value?.toLowerCase() === "multipart/report" && contentType.params?.["report-type"]?.toLowerCase() === "delivery-status";
}

function parseRfc3464(mail: ParsedMail): (ParsedBounce & { kind: "bounce" }) | null {
  if (!isDeliveryStatusReport(mail)) return null;

  let dsn: DsnResult = null;
  let originalMessageId: string | null = null;
  for (const att of mail.attachments) {
    const contentType = att.contentType.toLowerCase();
    if (contentType === "message/delivery-status" && !dsn) {
      dsn = parseDeliveryStatus(att.content.toString("utf8"));
    } else if ((contentType === "message/rfc822" || contentType === "text/rfc822-headers") && originalMessageId === null) {
      originalMessageId = extractOriginalMessageId(att.content.toString("utf8"));
    }
  }
  if (!dsn) return null;
  return { kind: "bounce", recipient: dsn.recipient, status: dsn.status, hard: isHard(dsn.status), originalMessageId, method: "rfc3464" };
}

/** Legacy BounceManager.cs:89-156: subject substring check, first email address anywhere in
 * the body, first error code by the two patterns above — no Message-ID (legacy never read
 * one). */
function parseHeuristic(mail: ParsedMail): (ParsedBounce & { kind: "bounce" }) | null {
  const subject = mail.subject ?? "";
  if (!subject.startsWith(UNDELIVERABLE_PREFIX)) return null;

  const body = mail.text ?? (typeof mail.html === "string" ? mail.html : "");
  const recipient = EMAIL_IN_BODY.exec(body)?.[0];
  const code = DOTTED_CODE.exec(body)?.[1] ?? SHORT_CODE.exec(body)?.[1];
  if (!recipient || !code) return null;

  return { kind: "bounce", recipient, status: code, hard: isHard(code), originalMessageId: null, method: "heuristic" };
}

/**
 * RFC 3464 first (Global Constraints "Parsing" §1), falling back to the legacy heuristic
 * (§2) when the message isn't a delivery-status report, or is one but doesn't actually carry
 * the fields we need. Never throws — a message that's neither, or isn't parseable at all (a
 * genuinely malformed .eml), is reported `ignored` instead.
 */
export async function parseBounce(raw: string): Promise<ParsedBounce> {
  let mail: ParsedMail;
  try {
    mail = await simpleParser(raw, { keepDeliveryStatus: true });
  } catch {
    return { kind: "ignored", reason: "malformed message" };
  }

  try {
    const rfc3464 = parseRfc3464(mail);
    if (rfc3464) return rfc3464;

    const heuristic = parseHeuristic(mail);
    if (heuristic) return heuristic;

    return { kind: "ignored", reason: "not recognisable as a bounce" };
  } catch {
    return { kind: "ignored", reason: "malformed message" };
  }
}
