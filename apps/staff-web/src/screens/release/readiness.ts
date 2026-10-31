import { approveProblems, publishProblems, type ReleaseView } from "@gcpe/nrms-contract";

/**
 * What a release still needs, as Actions lists it (ActionsSection.tsx), and the id of that list,
 * which the header's "Not ready" line links to (HeaderSection.tsx). One list, shown once, with
 * links (forms-b #16). Approve's list on a draft. The publish list on a draft, an approved or failed
 * release, and (fix round 1, finding 2) a scheduled or published one too, since every publish re-runs
 * publishProblems (apps/nrms/src/publisher.ts): the scheduled time, or a published release's next
 * save. A draft's publish list leaves out what Approve already lists.
 */
export interface Readiness {
  approve: string[];
  publish: string[];
  /** The id of the list Actions shows the publish problems in. */
  publishListId: "actions-publish-why" | "actions-publish-later";
}

/** The ids ActionsSection gives its lists. */
export const APPROVE_LIST_ID = "actions-approve-why";

export function readiness(view: ReleaseView): Readiness {
  const draft = view.status === "draft";
  const approvedOrFailed = view.status === "approved" || view.status === "failed";
  const goingOut = view.status === "scheduled" || view.status === "published";
  const approve = draft ? approveProblems(view) : [];
  const publish = draft || approvedOrFailed || goingOut ? publishProblems(view).filter((p) => !approve.includes(p)) : [];
  return { approve, publish, publishListId: approvedOrFailed && view.key !== null ? "actions-publish-why" : "actions-publish-later" };
}
