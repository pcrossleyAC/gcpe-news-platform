import { useEffect, useState } from "react";
import { typeRules, type EmailAgainChoice, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { dateTimeText } from "../../calendar/list/dates";

/** Nothing ticked: "Also email it again?" starts unticked every time (owner decision 2026-10-31). */
export const NO_EMAIL_AGAIN: EmailAgainChoice = { subscribers: false, mediaLists: false };

/** `GET /nrms/api/releases/:id/email-again-audience` (apps/nrms/src/releases/workflow.ts
 * emailAgainAudience, from NoD's own rules for corrected copies): null for a tick this release
 * can't offer; `count` null when NoD couldn't say. */
interface EmailAgainAudience {
  subscribers: { count: number | null } | null;
  mediaContacts: { count: number | null } | null;
  both: number | null;
}

/**
 * Which ticks a release can offer, as the server decides (workflow.ts emailAgainOffer): only once
 * it has gone out; subscribers while its type goes to, and it is set to go to, News on Demand
 * subscribers (an advisory goes to media lists only); media lists while it goes to at least one.
 * Null when it offers neither.
 */
export function emailAgainOffer(view: ReleaseView): EmailAgainChoice | null {
  if (!view.everPublished && view.releasedAt === null) return null;
  const rules = typeRules(view.type);
  const offer = { subscribers: rules.nodAllowed && view.publishOptions.toSubscribers, mediaLists: rules.mediaListsAllowed && view.publishOptions.toMediaLists && view.mediaListKeys.length > 0 };
  return offer.subscribers || offer.mediaLists ? offer : null;
}

/** The choice to send: undefined when nothing is ticked (the same as not asking). */
export const emailAgainBody = (c: EmailAgainChoice): EmailAgainChoice | undefined => (c.subscribers || c.mediaLists ? c : undefined);

const people = (n: number) => `${n.toLocaleString("en-CA")} ${n === 1 ? "person" : "people"}`;

/**
 * "Also email it again?" for a republish of a release that has already gone out (owner decision
 * 2026-10-31): a tick for subscribers and one for media lists, each with how many people already
 * got it and would get it again, unticked to start. Those ticked get the release as saved, with
 * "Corrected:" before the subject; nobody new. Renders nothing for a release that can't offer
 * either tick.
 */
export function EmailAgainFields({
  view,
  value,
  onChange,
  timeZone,
  scheduled = false,
}: {
  view: ReleaseView;
  value: EmailAgainChoice;
  onChange(next: EmailAgainChoice): void;
  timeZone: string;
  /** In the Schedule confirmation: who gets it is worked out when it goes out (review M5). */
  scheduled?: boolean;
}): React.JSX.Element | null {
  const offer = emailAgainOffer(view);
  // undefined while counting; null when the counts couldn't be fetched.
  const [audience, setAudience] = useState<EmailAgainAudience | null | undefined>(undefined);
  const offered = offer !== null;
  useEffect(() => {
    if (!offered) return;
    let active = true;
    setAudience(undefined);
    apiFetch<EmailAgainAudience>(`/nrms/api/releases/${view.id}/email-again-audience`).then(
      (a) => active && setAudience(a && typeof a === "object" && "both" in a ? a : null),
      () => active && setAudience(null),
    );
    return () => {
      active = false;
    };
  }, [offered, view.id, view.version]);
  if (!offer) return null;

  const countOf = (a: { count: number | null } | null | undefined): number | null => (audience && a?.count != null ? a.count : null);
  const subs = countOf(audience?.subscribers);
  const media = countOf(audience?.mediaContacts);
  const countText = (n: number | null) => (audience === undefined ? "counting…" : n === null ? "count unavailable" : n === 0 ? "nobody to email" : people(n));
  const both = audience?.both ?? 0;
  const total = value.subscribers || value.mediaLists ? (value.subscribers ? (subs ?? 0) : 0) + (value.mediaLists ? (media ?? 0) : 0) - (value.subscribers && value.mediaLists ? both : 0) : 0;
  const totalKnown = (!value.subscribers || subs !== null) && (!value.mediaLists || media !== null);

  return (
    <fieldset className="gcpe-email-again" aria-describedby={`email-again-hint-${view.id}`}>
      <legend>Also email it again?</legend>
      <p id={`email-again-hint-${view.id}`} className="gcpe-hint">
        Only people who already got it, and are still subscribed, get it again: the release as saved, with &ldquo;Corrected:&rdquo; before the subject. Nobody new is emailed.
        {scheduled ? " These numbers are as of now; who gets it is worked out when it goes out." : ""}
      </p>
      {view.lastCorrection && (
        // Review M4: two editors fixing the same mistake would email everyone twice.
        <p className="gcpe-release-editor__media-warning">
          {`Already emailed a correction on ${dateTimeText(view.lastCorrection.requestedAt, timeZone)}, asked for by ${view.lastCorrection.requestedBy}. This sends another to the same people.`}
        </p>
      )}
      {offer.subscribers && (
        <label className="gcpe-check">
          <input type="checkbox" checked={value.subscribers} disabled={subs === 0 && !value.subscribers} onChange={(e) => onChange({ ...value, subscribers: e.target.checked })} />
          News on Demand subscribers who got it ({countText(subs)})
        </label>
      )}
      {offer.mediaLists && (
        <label className="gcpe-check">
          <input type="checkbox" checked={value.mediaLists} disabled={media === 0 && !value.mediaLists} onChange={(e) => onChange({ ...value, mediaLists: e.target.checked })} />
          Media list contacts who got it ({countText(media)})
        </label>
      )}
      {(value.subscribers || value.mediaLists) && totalKnown && (
        <p>
          {total === 0 ? "Nobody is emailed again." : `Emails ${people(total)} again.`}
          {value.subscribers && value.mediaLists && both > 0 ? ` ${people(both)} in both get${both === 1 ? "s" : ""} one copy, the media one.` : ""}
        </p>
      )}
    </fieldset>
  );
}
