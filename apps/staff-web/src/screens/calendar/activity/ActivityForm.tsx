import type { ReactNode } from "react";
import { releaseFieldsetHidden, warningsFor, type ActivityFields, type EditorOptions, type HqSection, type HqStatus, type LookAheadInference, type NeedsReviewKey } from "@gcpe/calendar-contract";
import type { CalendarMe } from "../access";
import type { CalendarConfigView } from "../list/types";
import { CheckField, CheckList, DateTimeField, ReadOnlyForm, SelectField, TagField, TextField } from "./fields";
import {
  categoryChoices, commContactChoices, fieldId, inferredLabel, leadMinistryChoices, lookupChoices, needsReviewOf, SECTION_LABELS, sharedWithChoices,
  termChoices, translationChoices, withAllDay, withCategory, withMinistry, withMyContact,
} from "./form";

export type Change = (patch: Partial<ActivityFields> | ((f: ActivityFields) => ActivityFields)) => void;
export interface ActivityFormProps {
  fields: ActivityFields;
  /** The stored values: an inactive value the activity already holds stays offered. */
  stored: ActivityFields | null;
  change: Change;
  options: EditorOptions;
  config: CalendarConfigView;
  me: CalendarMe;
  errors: Map<string, string[]>;
  needsReview: readonly NeedsReviewKey[];
  lookAhead: { visible: boolean; inferred: LookAheadInference; overridden: boolean; choose: (s: HqSection) => void; reset: () => void };
  today: string;
  /** Nothing can be changed: each checklist lists only what is chosen. */
  readOnly: boolean;
  /** "BC Gov News", at the end of the Release fieldset. */
  release: ReactNode;
  /** Records, after Event. */
  records: ReactNode;
  /**
   * A new activity's legacy prefills (Activity.aspx:1528-1537, Activity.aspx.cs:339-368): End date
   * follows Start date, and Comm Contact is the user for each lead ministry they are a contact of,
   * until the user sets each one; `chose` says they have.
   */
  prefill?: { endFollowsStart: boolean; contactFollowsMinistry: boolean; myUserId: string; chose: (what: "end" | "contact") => void };
}

const str = (v: number | string | null) => (v === null ? "" : String(v));
const num = (v: string) => (v === "" ? null : Number(v));
const SECTIONS = (Object.keys(SECTION_LABELS) as HqSection[]).map((k) => ({ value: k, label: SECTION_LABELS[k] }));

/**
 * Legacy's fieldsets (spec addendum §8.2; Activity.aspx), in an order that works down the page
 * (owner, 2026-10-30): Ministry before Planning, so Lead Ministry comes before the Comm Contact it
 * offers; All Day and Dates Confirmed before the times; Look Ahead after every field its section is
 * inferred from.
 */
export function ActivityForm(p: ActivityFormProps): React.JSX.Element {
  const { fields: f, stored: s, change, options: o, config } = p;
  const rules = config.rules;
  const relax = config.editor.relaxRequired;
  const err = (k: string) => p.errors.get(k);
  const rev = (k: keyof ActivityFields) => needsReviewOf(k, p.needsReview);
  const id = fieldId;
  const categoryName = o.categories.find((c) => c.id === f.categoryId)?.name ?? null;
  const isRelease = f.categoryId !== null && rules.releaseCategoryIds.includes(f.categoryId);
  const la = f.lookAhead;
  const setLa = (patch: Partial<NonNullable<ActivityFields["lookAhead"]>>) => change((x) => ({ ...x, lookAhead: { ...x.lookAhead!, ...patch } }));
  const warnings = warningsFor(f, p.today);
  const one = (key: keyof ActivityFields) => [s ? (s[key] as number | null) : null];

  return (
    <ReadOnlyForm.Provider value={p.readOnly}>
      <fieldset className="gcpe-fieldset">
        <legend>Overview</legend>
        <SelectField id={id("categoryId")} label="Category" required value={str(f.categoryId)} onChange={(v) => change((x) => withCategory(x, num(v), o, rules))} options={categoryChoices(o, rules, config.editor.useHqPlaceholder, s?.categoryId ?? null)} empty="Choose a category" error={err("categoryId")} review={rev("categoryId")} />
        <CheckField id={id("isConfidential")} label="Confidential (not for Look Ahead)" help="not-for-look-ahead" hint="Only its lead and shared ministries, and HQ Advanced users and above, see it. A Look Ahead section it already has is kept." checked={f.isConfidential} onChange={(v) => change({ isConfidential: v })} review={rev("isConfidential")} />
        <TextField id={id("title")} label="Title" required value={f.title} onChange={(v) => change({ title: v })} error={err("title")} review={rev("title")} hint="At most 100 characters." />
        <TextField id={id("details")} label="Summary" multiline required={!relax} value={f.details} onChange={(v) => change({ details: v })} error={err("details")} review={rev("details")} hint="At most 700 characters." />
        <CheckField id={id("isIssue")} label="Issue" checked={f.isIssue} onChange={(v) => change({ isIssue: v })} review={rev("isIssue")} />
        <TextField id={id("significance")} label="Significance" multiline required={rules.required.significance && !relax} value={f.significance} onChange={(v) => change({ significance: v })} error={err("significance")} review={rev("significance")} />
        <TextField id={id("leadOrganization")} label="Lead Organization" help="lead-organization" value={f.leadOrganization} onChange={(v) => change({ leadOrganization: v })} error={err("leadOrganization")} review={rev("leadOrganization")} />
        <CheckList readOnly={p.readOnly} id={id("initiativeIds")} label="HQ Initiatives & Leads" values={f.initiativeIds.map(String)} onChange={(v) => change({ initiativeIds: v.map(Number) })} options={lookupChoices(o.initiatives, s?.initiativeIds ?? [])} error={err("initiativeIds")} review={rev("initiativeIds")} />
        <TagField id={id("keywordNames")} label="HQ Tags" values={f.keywordNames} onChange={(v) => change({ keywordNames: v })} suggestions={o.keywords.filter((k) => k.isActive).map((k) => k.name)} error={err("keywordNames")} review={rev("keywordNames")} />
      </fieldset>

      <fieldset className="gcpe-fieldset">
        <legend>Ministry</legend>
        <SelectField id={id("contactMinistryKey")} label="Lead Ministry" required value={f.contactMinistryKey ?? ""} onChange={(v) => change((x) => {
          const next = withMinistry(x, v || null, o);
          return p.prefill?.contactFollowsMinistry ? withMyContact(next, o, p.prefill.myUserId) : next;
        })} options={leadMinistryChoices(o, rules, p.me, s?.contactMinistryKey ?? null)} empty="Choose the lead ministry" error={err("contactMinistryKey")} />
        <CheckField id={id("isCrossGovernment")} label="Cross-Government" checked={f.isCrossGovernment} onChange={(v) => change({ isCrossGovernment: v })} />
        <CheckList readOnly={p.readOnly} id={id("sharedWithKeys")} label="Shared With" values={f.sharedWithKeys} onChange={(v) => change({ sharedWithKeys: v })} options={sharedWithChoices(o, rules, s?.sharedWithKeys ?? [])} error={err("sharedWithKeys")} />
      </fieldset>

      <fieldset className="gcpe-fieldset">
        <legend>Planning</legend>
        <SelectField id={id("commContactId")} label="Comm Contact" help="comm-contact" required value={str(f.commContactId)} onChange={(v) => {
          p.prefill?.chose("contact");
          change({ commContactId: num(v) });
        }} options={commContactChoices(o, f.contactMinistryKey, s?.commContactId ?? null)} empty={f.contactMinistryKey ? "Choose a comm contact" : "Choose the lead ministry first"} error={err("commContactId")} />
        <CheckField id={id("isMilestone")} label="Key activity" checked={f.isMilestone} onChange={(v) => change({ isMilestone: v })} />
        <TextField id={id("strategy")} label="Strategy" multiline required={rules.required.strategy} value={f.strategy} onChange={(v) => change({ strategy: v })} error={err("strategy")} review={rev("strategy")} />
        <CheckList readOnly={p.readOnly} id={id("commMaterialIds")} label="Comm Materials" help="comm-materials" required={isRelease} values={f.commMaterialIds.map(String)} onChange={(v) => change({ commMaterialIds: v.map(Number) })} options={lookupChoices(o.commMaterials, s?.commMaterialIds ?? [])} error={err("commMaterialIds")} review={rev("commMaterialIds")} />
        <TextField id={id("comments")} label="Internal notes" multiline value={f.comments} onChange={(v) => change({ comments: v })} error={err("comments")} review={rev("comments")} />
      </fieldset>

      <fieldset className="gcpe-fieldset">
        <legend>Schedule</legend>
        <CheckField id={id("isAllDay")} label="All Day" checked={f.isAllDay} onChange={(v) => change((x) => withAllDay(x, v))} />
        <CheckField id={id("isConfirmed")} label="Dates Confirmed" checked={f.isConfirmed} onChange={(v) => change({ isConfirmed: v })} />
        <DateTimeField idDate={id("startDate")} idTime={id("startTime")} label="Start" required date={f.startDate} time={f.startTime} onDate={(v) => change(p.prefill?.endFollowsStart && v ? { startDate: v, endDate: v } : { startDate: v })} onTime={(v) => change({ startTime: v })} showTime={!f.isAllDay} dateError={err("startDate")} timeError={err("startTime")} review={rev("startDate")} />
        <DateTimeField idDate={id("endDate")} idTime={id("endTime")} label="End" required date={f.endDate} time={f.endTime} onDate={(v) => {
          p.prefill?.chose("end");
          change({ endDate: v });
        }} onTime={(v) => change({ endTime: v })} showTime={!f.isAllDay} dateError={err("endDate")} timeError={err("endTime")} review={rev("endDate")} />
        <TextField id={id("potentialDates")} label="Potential Dates" value={f.potentialDates} onChange={(v) => change({ potentialDates: v })} error={err("potentialDates")} review={rev("potentialDates")} hint="A general timeline, like winter or late June: no numbers, TBC or TBD." />
        <TextField id={id("schedule")} label="Scheduling considerations" multiline required={rules.required.scheduling && !relax} value={f.schedule} onChange={(v) => change({ schedule: v })} error={err("schedule")} review={rev("schedule")} />
        {!p.readOnly && warnings.length > 0 && (
          <ul className="gcpe-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </fieldset>

      {!releaseFieldsetHidden(categoryName, rules) && (
        <fieldset className="gcpe-fieldset">
          <legend>Release</legend>
          <DateTimeField idDate={id("nrDate")} idTime={id("nrTime")} label="Release" date={f.nrDate} time={f.nrTime} onDate={(v) => change({ nrDate: v })} onTime={(v) => change({ nrTime: v })} showTime timeHint="Fill in both the release date and time, or leave both empty." dateError={err("nrDate")} timeError={err("nrTime")} />
          <SelectField id={id("nrOriginId")} label="Origin" help="nr-origin" required={isRelease} value={str(f.nrOriginId)} onChange={(v) => change({ nrOriginId: num(v) })} options={lookupChoices(o.origins, one("nrOriginId"))} empty="None" error={err("nrOriginId")} review={rev("nrOriginId")} />
          <SelectField id={id("nrDistributionId")} label="Distribution" required={isRelease} value={str(f.nrDistributionId)} onChange={(v) => change({ nrDistributionId: num(v) })} options={lookupChoices(o.distributions, one("nrDistributionId"))} empty="None" error={err("nrDistributionId")} review={rev("nrDistributionId")} />
          <CheckList readOnly={p.readOnly} id={id("translations")} label="Translations Required" values={f.translations} onChange={(v) => change({ translations: v })} options={translationChoices(rules.translationsDefault, s?.translations ?? f.translations)} error={err("translations")} review={rev("translations")} />
          <CheckList readOnly={p.readOnly} id={id("sectorKeys")} label="Sectors" values={f.sectorKeys} onChange={(v) => change({ sectorKeys: v })} options={termChoices(o.sectors, s?.sectorKeys ?? [])} error={err("sectorKeys")} />
          <CheckList readOnly={p.readOnly} id={id("themeKeys")} label="Themes" values={f.themeKeys} onChange={(v) => change({ themeKeys: v })} options={termChoices(o.themes, s?.themeKeys ?? [])} error={err("themeKeys")} />
          <CheckList readOnly={p.readOnly} id={id("tagKeys")} label="News Subscribe" values={f.tagKeys} onChange={(v) => change({ tagKeys: v })} options={termChoices(o.tags, s?.tagKeys ?? [])} error={err("tagKeys")} />
          {p.release}
        </fieldset>
      )}

      <fieldset className="gcpe-fieldset">
        <legend>Event</legend>
        <SelectField id={id("premierRequestedId")} label="Premier Requested" value={str(f.premierRequestedId)} onChange={(v) => change({ premierRequestedId: num(v) })} options={lookupChoices(o.premierRequested, one("premierRequestedId"))} empty="None" error={err("premierRequestedId")} review={rev("premierRequestedId")} />
        <SelectField id={id("governmentRepresentativeId")} label="Representative" help="government-representative" value={str(f.governmentRepresentativeId)} onChange={(v) => change({ governmentRepresentativeId: num(v) })} options={lookupChoices(o.representatives, one("governmentRepresentativeId"))} empty="None" error={err("governmentRepresentativeId")} review={rev("governmentRepresentativeId")} />
        <CheckField id={id("isAtLegislature")} label="At BC Legislature" checked={f.isAtLegislature} onChange={(v) => change({ isAtLegislature: v })} />
        <SelectField id={id("cityId")} label="City" value={str(f.cityId)} onChange={(v) => change({ cityId: num(v) })} options={lookupChoices(o.cities, one("cityId"))} empty="None" error={err("cityId")} review={rev("cityId")} />
        {f.cityId === rules.otherCityId && (
          <TextField id={id("otherCity")} label="Other City" value={f.otherCity} onChange={(v) => change({ otherCity: v })} error={err("otherCity")} review={rev("otherCity")} />
        )}
        <TextField id={id("venue")} label="Venue" value={f.venue} onChange={(v) => change({ venue: v })} error={err("venue")} review={rev("venue")} />
        <SelectField id={id("eventPlannerId")} label="Event Planner" value={str(f.eventPlannerId)} onChange={(v) => change({ eventPlannerId: num(v) })} options={lookupChoices(o.eventPlanners, one("eventPlannerId"))} empty="None" error={err("eventPlannerId")} review={rev("eventPlannerId")} />
        <SelectField id={id("videographerId")} label="Digital" value={str(f.videographerId)} onChange={(v) => change({ videographerId: num(v) })} options={lookupChoices(o.videographers, one("videographerId"))} empty="None" error={err("videographerId")} review={rev("videographerId")} />
      </fieldset>

      {p.lookAhead.visible && la && (
        <fieldset className="gcpe-fieldset">
          <legend>Look Ahead</legend>
          <TextField id={id("lookAhead.hqComments")} label="Executive Summary" multiline value={la.hqComments} onChange={(v) => setLa({ hqComments: v })} error={err("lookAhead.hqComments")} hint="At most 2000 characters." />
          <SelectField id={id("lookAhead.hqStatus")} label="LA Status" help="la-status" value={la.hqStatus ?? ""} onChange={(v) => setLa({ hqStatus: (v || null) as HqStatus | null })} options={[{ value: "new", label: "New" }, { value: "changed", label: "Changed" }]} empty="None" />
          {p.lookAhead.inferred.kind === "section" ? (
            <div className={p.lookAhead.overridden ? "gcpe-override" : undefined}>
              <SelectField id={id("lookAhead.hqSection")} label="LA Section" help="la-section" value={la.hqSection} onChange={(v) => p.lookAhead.choose(v as HqSection)} options={SECTIONS} hint={p.lookAhead.overridden ? `Override (inferred: ${inferredLabel(p.lookAhead.inferred)})` : "Inferred from Category, Issue, Confidential, Lead Ministry, Comm Materials, Dates Confirmed and the start and end dates"} />
              {p.lookAhead.overridden && (
                <button type="button" className="gcpe-small-button" onClick={p.lookAhead.reset}>
                  Use the inferred section
                </button>
              )}
            </div>
          ) : (
            <p id={id("lookAhead.hqSection")}>{`LA Section: ${inferredLabel(p.lookAhead.inferred)}. Set by the category or the ministry; it can't be overridden.`}</p>
          )}
          <CheckField id={id("lookAhead.longTermOutlook")} label="Long Term Outlook" checked={la.longTermOutlook} onChange={(v) => setLa({ longTermOutlook: v })} />
        </fieldset>
      )}

      {p.records}
    </ReadOnlyForm.Provider>
  );
}
