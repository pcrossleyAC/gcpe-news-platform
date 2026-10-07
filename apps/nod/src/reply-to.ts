import type { ItemKind } from "./db/schema";

export interface ReplyToOptions {
  /** NOD_REPLY_TO: production sets gcpe.news@gov.bc.ca; test sites leave it unset so a reply
   * to redirected test mail never reaches a real government mailbox. */
  news?: string;
}

/**
 * Reply-To by type of news, after legacy's Bounce Manager: releases, advisories, stories and
 * factsheets (every NRMS post kind, including legacy-only updates) reply to NOD_REPLY_TO.
 * Everything else (digests, emergency items, verification and manage links, ops mail) carries
 * none, so a reply goes to the From mailbox, which is what legacy's "only noreply" amounted to.
 */
export function replyToFor(itemKind: ItemKind | null, opts: ReplyToOptions): string | undefined {
  return itemKind === "release" ? opts.news : undefined;
}
