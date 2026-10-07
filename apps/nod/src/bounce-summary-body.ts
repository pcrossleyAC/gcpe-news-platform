import { escapeHtml } from "@gcpe/http-kit";
import type { SubscriberStatus } from "./db/schema";

/** One subscriber acted on by the 10-in-15-days rule in the window. */
export interface HardLine {
  email: string;
  status: string | null;
  outcome: string;
  mediaMember: boolean;
}

/** A soft or unrecorded bounce from Distribution, with what NoD knows about the address. */
export interface ListedBounce {
  address: string;
  status: string | null;
  message: string | null;
  subject: string | null;
  subscriber: SubscriberStatus | null;
  mediaMember: boolean;
}

export interface SummaryBodyInput {
  processed: number;
  bounces: number;
  ignored: number;
  hard: HardLine[];
  soft: { count: number; rows: ListedBounce[] };
  unrecorded: { count: number; rows: ListedBounce[] };
  generatedAt: string;
  timeZone: string;
}

type Line = { text: string; bold: boolean };

/** A 4.x.x code only reaches the hard lines when staff count it (Operations). */
function hardText(l: HardLine): string {
  const kind = l.status?.startsWith("4") ? "soft, counted as hard" : "hard";
  return `${l.email} - ${kind}${l.status ? ` (${l.status})` : ""}: ${l.outcome}`;
}

function listedText(b: ListedBounce, withSubscriber: boolean): string {
  const detail = [b.status, b.message].filter((s): s is string => !!s).join(" ");
  let text = detail ? `${b.address} (${detail})` : b.address;
  if (b.subject) text += ` - ${b.subject}`;
  if (withSubscriber) text += b.subscriber ? ` - NoD subscriber (${b.subscriber})` : " - not a NoD subscriber";
  return text;
}

function section(heading: string, lines: Line[], notListed: number): { html: string; text: string } {
  const more = notListed > 0 ? [{ text: `…and ${notListed} more not listed here; see the bounce mailbox.`, bold: false }] : [];
  // "None." only when the section is truly empty, never above a "…and N more" line.
  const all = lines.length > 0 || more.length > 0 ? [...lines, ...more] : [{ text: "None.", bold: false }];
  return {
    html: [`<h3>${escapeHtml(heading)}</h3>`, ...all.map((l) => `<p>${l.bold ? `<b>${escapeHtml(l.text)}</b>` : escapeHtml(l.text)}</p>`)].join("\n"),
    text: [heading, ...all.map((l) => l.text)].join("\n"),
  };
}

/**
 * The daily summary's body, in legacy Bounce Manager's parts: the total processed, then hard
 * lines (counted), soft bounces (listed, not counted) and unrecorded bounces (not counted;
 * staff check the mailbox). Media-list members are bold in the HTML part, as legacy did.
 * Every value is escaped: addresses, diagnostics and subjects come from outside.
 */
export function buildSummaryBody(input: SummaryBodyInput): { html: string; text: string } {
  const intro = `Bounce reports processed: ${input.processed} (${input.bounces} bounces; ${input.ignored} other messages, such as auto-replies, not processed).`;
  const sections = [
    section(`Hard bounces (${input.hard.length}): count toward 10 in 15 days`, input.hard.map((l) => ({ text: hardText(l), bold: l.mediaMember })), 0),
    section(
      `Soft bounces (${input.soft.count}): not counted, usually no action needed`,
      input.soft.rows.map((b) => ({ text: listedText(b, false), bold: b.mediaMember })),
      input.soft.count - input.soft.rows.length,
    ),
    section(
      `Unrecorded bounces (${input.unrecorded.count}): not counted; check the bounce mailbox`,
      input.unrecorded.rows.map((b) => ({ text: listedText(b, true), bold: b.mediaMember })),
      input.unrecorded.count - input.unrecorded.rows.length,
    ),
  ];
  const legend = "Bold: on one or more media distribution lists.";
  const footer = `Generated on ${input.generatedAt} (${input.timeZone}).`;
  return {
    html: [`<p>${escapeHtml(intro)}</p>`, ...sections.map((s) => s.html), `<p>${escapeHtml(legend)}</p>`, `<p>${escapeHtml(footer)}</p>`].join("\n"),
    text: [intro, "", ...sections.flatMap((s) => [s.text, ""]), footer].join("\n"),
  };
}
