import { escapeHtml } from "@gcpe/http-kit";
import { DistributionError, type DistributionClient } from "../distribution-client";

export type SystemEmailKind = "verify" | "manage" | "change-email";

const WORDING: Record<SystemEmailKind, { subject: string; heading: string; lines: string[]; action: string }> = {
  verify: {
    subject: "BC Gov News On Demand Email Verification",
    heading: "Confirm your request",
    lines: ["Thank you for subscribing to BC Gov News On Demand."],
    action: "To confirm your request and begin receiving communications by email, click here:",
  },
  "change-email": {
    subject: "BC Gov News On Demand Email Verification",
    heading: "Confirm your new email address",
    lines: ["You asked to receive BC Gov News On Demand at this address."],
    action: "To confirm this address and move your subscription to it, click here:",
  },
  manage: {
    subject: "BC Gov News On Demand Subscription Management",
    heading: "Manage your subscription",
    lines: [],
    action: "To log in and manage your subscription, click here:",
  },
};

export function renderSystemEmail(kind: SystemEmailKind, link: string): { subject: string; html: string; text: string } {
  const w = WORDING[kind];
  const text = [w.heading, "", ...w.lines.flatMap((l) => [l, ""]), `${w.action} ${link}`, "", "This link expires in 24 hours."].join("\n");
  const html =
    `<h1>${escapeHtml(w.heading)}</h1>` +
    w.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p>${escapeHtml(w.action)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
    `<p>This link expires in 24 hours.</p>`;
  return { subject: w.subject, html, text };
}

export function linkUrl(pageUrl: string, token: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Never throws: a failed send is logged (without the address) and the caller's response is
 * unchanged — anti-enumeration means the caller can't say "we couldn't email you" anyway. */
export async function sendSystemEmail(
  distribution: Pick<DistributionClient, "send">,
  to: string,
  kind: SystemEmailKind,
  link: string,
  idempotencyKey: string,
): Promise<void> {
  const { subject, html, text } = renderSystemEmail(kind, link);
  try {
    await distribution.send({ priority: "system", idempotencyKey, subject, html, text, headers: {}, recipients: [{ email: to, substitutions: {} }] });
  } catch (e) {
    // Never e.message: a DistributionError's message can carry Distribution's raw HTTP response
    // body (Minor 10, reviewer finding). Its status (or, failing that, its error name) says
    // enough to triage without risking whatever Distribution put in that body.
    const label = e instanceof DistributionError ? (e.status !== undefined ? `HTTP ${e.status}` : e.name) : e instanceof Error ? e.name : "error";
    console.error(`[nod] ${kind} email ${idempotencyKey} failed: ${label}`);
  }
}
