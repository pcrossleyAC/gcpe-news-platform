import { escapeHtml } from "@gcpe/http-kit";
import { statusText, TYPE_LABEL, type ReleaseView } from "@gcpe/nrms-contract";
import type { MessageRequestLike } from "../clients";
import { cpDate, type RenditionOptions } from "./model";

export interface EmailCopyInput {
  view: ReleaseView;
  /** The first document's English headline. */
  headline: string;
  leadOrganization: string;
  mediaListNames: string[];
  text: string;
  pdf: Buffer;
  to: string;
}

/**
 * "Email me a copy": a summary table, then the text version in a <pre>, with the PDF and text
 * versions attached. Everything interpolated into the HTML is escaped.
 */
export function buildEmailCopy(input: EmailCopyInput, opts: RenditionOptions): MessageRequestLike {
  const { view: v } = input;
  const label = v.reference ? "FINAL" : "DRAFT";
  const base = `${label}-${(v.key ?? v.id).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const at = v.releasedAt ?? v.publishAt;
  const rows: [string, string][] = [
    ["Reference", v.reference ?? "Not approved"],
    ["Key", v.key ?? ""],
    ["Type", TYPE_LABEL[v.type]],
    ["Status", statusText(v, opts.nowMs)],
    ["Date", at ? cpDate(new Date(at), opts.timeZone) : "Not set"],
    ["Media lists", input.mediaListNames.join(", ")],
    ["Lead organization", input.leadOrganization],
    ["Headline", input.headline],
  ];
  const table = rows
    .map(([k, val]) => `<tr><th align="left" valign="top">${escapeHtml(k)}</th><td>${escapeHtml(val)}</td></tr>`)
    .join("");
  return {
    priority: "system",
    // Distribution refuses a subject with line breaks; a headline shouldn't have any, but never fail on one.
    subject: `${label} - ${input.headline}`.replace(/[\r\n]+/g, " "),
    html: `<table cellpadding="4">${table}</table><pre>${escapeHtml(input.text)}</pre>`,
    text: input.text,
    recipients: [{ email: input.to }],
    attachments: [
      { filename: `${base}.pdf`, contentType: "application/pdf", contentBase64: input.pdf.toString("base64") },
      { filename: `${base}.txt`, contentType: "text/plain", contentBase64: Buffer.from(input.text, "utf8").toString("base64") },
    ],
  };
}
