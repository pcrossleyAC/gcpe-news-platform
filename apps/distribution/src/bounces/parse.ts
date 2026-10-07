import { simpleParser, type ParsedMail } from "mailparser";

export type ParsedBounce =
  | {
      kind: "bounce";
      recipient: string;
      status: string;
      hard: boolean;
      originalMessageId: string | null;
      method: "rfc3464" | "heuristic";
      /** What the remote server said, for staff (the daily summary): whitespace-collapsed and capped. */
      diagnostic: string | null;
      /** The bounced email's own subject, when the report carries it. */
      originalSubject: string | null;
    }
  | { kind: "ignored"; reason: string };

// Legacy BounceManager.cs:60-67 (research-4e.md A.1), ported for the heuristic fallback:
// the enhanced-status-code form is tried first, then the bare 3-digit form — both anchored on
// the delimiter the legacy code required ("#", ";" or whitespace) immediately before the code,
// so a stray "45" or "5.1.1" elsewhere in the body (a date, a price) isn't mistaken for one.
// Both quantifiers are bounded ({1,3}), so neither is vulnerable to the backtracking blowup
// EMAIL_CHAR/firstEmailLike below exists to avoid.
const DOTTED_CODE = /[#;\s]([45]\.\d{1,3}\.\d{1,3})/;
const SHORT_CODE = /[#;\s]([45]\d{2})/;
const UNDELIVERABLE_PREFIX = "Undeliverable:";

// Fix round 1, C1: a backtracking regex equivalent to `[\w.-]+@[\w.-]+`, run over
// attacker-controlled, unbounded content (the body, or a padded DSN address field) with no
// match, is quadratic — the reviewer measured ~514s on a 1MB body of "a". MAX_SCAN_CHARS bounds
// the work regardless of input size, and firstEmailLike below does the same match in one linear
// pass instead of leaning on the regex engine's own retry-at-every-start-position behaviour.
const MAX_SCAN_CHARS = 65_536;
const EMAIL_CHAR = /[\w.-]/;

// Diagnostic and subject text end up in a staff email and a DB column; both come from whoever
// sent the bounce, so they are bounded before anything else touches them.
const MAX_DETAIL_CHARS = 200;

function cleanDetail(s: string | null | undefined): string | null {
  if (!s) return null;
  const collapsed = s.slice(0, MAX_DETAIL_CHARS * 4).replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_DETAIL_CHARS ? `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…` : collapsed;
}

/** "smtp; 550 5.1.1 ..." -> "550 5.1.1 ..." (RFC 3464 §2.3.6: the diagnostic-type prefix). */
function stripDiagnosticType(value: string): string {
  return value.replace(/^\s*[A-Za-z0-9-]+\s*;\s*/, "");
}

/** The bounced email's Subject, decoded (RFC 2047) by handing just its header block to mailparser. */
async function subjectOfHeaders(content: string): Promise<string | null> {
  const headerBlock = content.split(/\r?\n\r?\n/)[0] ?? "";
  try {
    return (await simpleParser(`${headerBlock}\r\n\r\n`)).subject ?? null;
  } catch {
    return null;
  }
}

function subjectAfterUndeliverable(mail: ParsedMail): string | null {
  const subject = mail.subject ?? "";
  return subject.startsWith(UNDELIVERABLE_PREFIX) ? subject.slice(UNDELIVERABLE_PREFIX.length) : null;
}

function isHard(code: string): boolean {
  return code.trim().startsWith("5");
}

/**
 * The leftmost `[\w.-]+@[\w.-]+`-shaped span in `input` — found by locating each '@' and
 * expanding outward over the allowed character class, so the cost is linear in
 * `min(input.length, MAX_SCAN_CHARS)` regardless of whether (or how late) a match exists.
 */
function firstEmailLike(input: string): string | null {
  const s = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "@") {
      i++;
      continue;
    }
    let start = i;
    while (start > 0 && EMAIL_CHAR.test(s[start - 1]!)) start--;
    let end = i + 1;
    while (end < s.length && EMAIL_CHAR.test(s[end]!)) end++;
    if (start < i && end > i + 1) return s.slice(start, end);
    i = end; // no usable local-part/domain around this '@' — resume scanning after it
  }
  return null;
}

/** RFC 5322 §2.2.3 unfolding: a header value may continue onto following lines that start with
 * whitespace (folding, done purely so a generator can keep lines short) — each continuation
 * line is reattached to the field it belongs to before the line is parsed as `name: value`. */
function unfoldHeaderLines(block: string): string[] {
  const unfolded: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** A loose header-line block. Returns the first value for each lowercased header name. */
function parseHeaderBlock(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of unfoldHeaderLines(block)) {
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
  return firstEmailLike(value);
}

type DsnResult = { recipient: string; status: string; diagnostic: string | null } | null;

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
    return { recipient, status: status.trim(), diagnostic: cleanDetail(stripDiagnosticType(fields.get("diagnostic-code") ?? "")) };
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

async function parseRfc3464(mail: ParsedMail): Promise<(ParsedBounce & { kind: "bounce" }) | null> {
  if (!isDeliveryStatusReport(mail)) return null;

  let dsn: DsnResult = null;
  let originalMessageId: string | null = null;
  let originalSubject: string | null = null;
  for (const att of mail.attachments) {
    const contentType = att.contentType.toLowerCase();
    if (contentType === "message/delivery-status" && !dsn) {
      dsn = parseDeliveryStatus(att.content.toString("utf8"));
    } else if ((contentType === "message/rfc822" || contentType === "text/rfc822-headers") && originalMessageId === null) {
      const content = att.content.toString("utf8");
      originalMessageId = extractOriginalMessageId(content);
      originalSubject = await subjectOfHeaders(content);
    }
  }
  if (!dsn) return null;
  return {
    kind: "bounce",
    recipient: dsn.recipient,
    status: dsn.status,
    hard: isHard(dsn.status),
    originalMessageId,
    method: "rfc3464",
    diagnostic: dsn.diagnostic,
    originalSubject: cleanDetail(originalSubject ?? subjectAfterUndeliverable(mail)),
  };
}

/** Legacy BounceManager.cs:89-156: subject substring check, first email address anywhere in
 * the body, first error code by the two patterns above — no Message-ID (legacy never read
 * one). */
function parseHeuristic(mail: ParsedMail): (ParsedBounce & { kind: "bounce" }) | null {
  const subject = mail.subject ?? "";
  if (!subject.startsWith(UNDELIVERABLE_PREFIX)) return null;

  const fullBody = mail.text ?? (typeof mail.html === "string" ? mail.html : "");
  // C1: cap what's scanned — the body is attacker-controlled bounce content; a real NDR body
  // is a handful of lines, so 64 KB leaves generous room without ever letting the input size
  // decide how much work one bounce costs.
  const body = fullBody.length > MAX_SCAN_CHARS ? fullBody.slice(0, MAX_SCAN_CHARS) : fullBody;
  const recipient = firstEmailLike(body);
  const match = DOTTED_CODE.exec(body) ?? SHORT_CODE.exec(body);
  const code = match?.[1];
  if (!recipient || !match || !code) return null;

  const lineStart = body.lastIndexOf("\n", match.index) + 1;
  const lineEndAt = body.indexOf("\n", match.index);
  const line = body.slice(lineStart, lineEndAt < 0 ? body.length : lineEndAt).trim().replace(/^</, "").replace(/>$/, "");

  return {
    kind: "bounce",
    recipient,
    status: code,
    hard: isHard(code),
    originalMessageId: null,
    method: "heuristic",
    diagnostic: cleanDetail(line),
    originalSubject: cleanDetail(subjectAfterUndeliverable(mail)),
  };
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
    const rfc3464 = await parseRfc3464(mail);
    if (rfc3464) return rfc3464;

    const heuristic = parseHeuristic(mail);
    if (heuristic) return heuristic;

    return { kind: "ignored", reason: "not recognisable as a bounce" };
  } catch {
    return { kind: "ignored", reason: "malformed message" };
  }
}
