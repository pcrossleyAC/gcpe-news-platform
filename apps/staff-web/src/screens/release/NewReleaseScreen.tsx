import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import {
  CREATABLE_TYPES, LANG_EN, LAYOUTS, MAX_ACTIVITY_ID, TYPE_LABEL, createReleaseSchema, typeRules, type Layout, type ReleasePrefill, type ReleaseView,
} from "@gcpe/nrms-contract";
import type { ZodIssue } from "zod";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { dateTimeText } from "../calendar/list/dates";
import { ActivityLookupPanel, useActivityLookup } from "./ActivityLookupPanel";
import type { Categories } from "./categories";

type CreatableType = (typeof CREATABLE_TYPES)[number];

interface PageTypeOption {
  pageTitle: string;
  languageId: number;
  releaseType: string;
  sortOrder: number;
  layout: Layout;
  pageImageId: string | null;
}
interface PageImageOption {
  id: string;
  name: string;
  sortOrder: number;
}
interface MediaListOption {
  key: string;
  displayName: string;
  isActive: boolean;
}

const EMPTY_CATEGORIES: Categories = { ministries: [], sectors: [], themes: [], tags: [] };

/** Maps one of the server's free-text problem strings (422 `problems`, or a client-side zod
 * issue's `path`) to the field it's about — acceptance: "the API's 422 problems map to fields".
 * Anything unrecognised falls back to "general" (shown as a page-level alert, not lost). */
function fieldFor(problem: string): string {
  if (/calendar activity|activity id/i.test(problem)) return "activityId";
  if (/lead ministry/i.test(problem)) return "leadMinistryKey";
  if (/ministry|ministries/i.test(problem)) return "ministries";
  if (/sector/i.test(problem)) return "sectors";
  if (/theme/i.test(problem)) return "themes";
  if (/\btag/i.test(problem)) return "tags";
  if (/media distribution list/i.test(problem)) return "mediaListKeys";
  if (/page image/i.test(problem)) return "pageImageId";
  if (/headline/i.test(problem)) return "headline";
  if (/page ?title/i.test(problem)) return "pageTitle";
  return "general";
}

function groupByField(problems: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const p of problems) {
    const field = fieldFor(p);
    (grouped[field] ??= []).push(p);
  }
  return grouped;
}

/** Where each field is, for the error summary's links (the field itself, or its group). */
const FIELD_IDS: Record<string, string> = {
  type: "new-release-type",
  pageTitle: "new-release-page-title",
  layout: "new-release-layout",
  pageImageId: "new-release-page-image",
  headline: "new-release-headline",
  activityId: "new-release-activity-id",
  location: "new-release-location",
  ministries: "new-release-ministries",
  leadMinistryKey: "new-release-lead-ministry",
  sectors: "new-release-sectors",
  themes: "new-release-themes",
  tags: "new-release-tags",
  mediaListKeys: "new-release-media-lists",
};

/** The form's own checks, said the way the Calendar says them: what to do, not what the schema saw. */
function issueText(field: string, issue: ZodIssue): string {
  const tooLong = issue.code === "too_big" && "maximum" in issue ? Number(issue.maximum) : null;
  switch (field) {
    case "type":
      return "Choose a release type.";
    case "pageTitle":
      return tooLong !== null ? `Shorten the page title to ${tooLong} characters or fewer.` : "Choose a page title.";
    case "layout":
      return "Choose a layout.";
    case "pageImageId":
      return "Choose a page image from the list, or none.";
    case "headline":
      return tooLong !== null ? `Shorten the headline to ${tooLong} characters or fewer.` : "Enter a headline.";
    case "location":
      return tooLong !== null ? `Shorten the location to ${tooLong} characters or fewer.` : "Check the location.";
    case "activityId":
      // Its own messages are already plain ("Activity ID must be numeric").
      return /^(String|Number|Expected|Invalid)\b/.test(issue.message) ? "Enter the Calendar activity's number, such as 1234." : issue.message;
    case "ministries":
    case "leadMinistryKey":
      return "Check the ministries chosen.";
    case "sectors":
    case "themes":
    case "tags":
      return `Check the ${field} chosen.`;
    case "mediaListKeys":
      return "Check the media distribution lists chosen.";
    default:
      return issue.message;
  }
}

/** A typed activity id as a number, or null while it isn't one the Calendar could have. */
function activityIdOf(text: string): number | null {
  const t = text.trim();
  return /^\d{1,10}$/.test(t) && Number(t) >= 1 && Number(t) <= MAX_ACTIVITY_ID ? Number(t) : null;
}

/**
 * "Fix these to create": every problem, each a link to its field, as the Calendar's activity form
 * does. It takes focus when it appears, so a keyboard or screen-reader user lands on it.
 */
function ErrorSummary({ problems }: { problems: { field: string; message: string }[] }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const key = problems.map((p) => `${p.field}:${p.message}`).join("|");
  useEffect(() => {
    if (key) ref.current?.focus();
  }, [key]);
  if (problems.length === 0) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="gcpe-error-summary" aria-labelledby="new-release-errors-heading">
      <h2 id="new-release-errors-heading">Fix these to create</h2>
      <ul>
        {problems.map((p, i) => (
          <li key={`${p.field}-${i}`}>{FIELD_IDS[p.field] ? <a href={`#${FIELD_IDS[p.field]}`}>{p.message}</a> : p.message}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `/hub/releases/new` (task-3-brief.md): type, page title (from `GET /page-types`), layout,
 * page image (`GET /page-images`), categories, and headline — the fields shown and required
 * change per {@link typeRules}. Validates client-side with `createReleaseSchema` before
 * sending; on success, `POST /nrms/api/releases` and navigate to the new release's editor.
 * The Calendar activity id is looked up as it's typed (spec addendum §11), and legacy's
 * pre-fill from it is offered; started from a Forecast activity (`?activity=`), it is filled
 * in at once.
 */
export function NewReleaseScreen(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const timeZone = useTenantTimeZone();
  useDocumentTitle(session.has("NRMS.Editor") ? "New release" : "You don’t have permission to create releases");

  const [type, setType] = useState<CreatableType>("release");
  const [pageTitle, setPageTitle] = useState("");
  const [layout, setLayout] = useState<Layout>("formal");
  const [pageImageId, setPageImageId] = useState<string | null>(null);
  const [headline, setHeadline] = useState("");
  const [ministries, setMinistries] = useState<string[]>([]);
  const [leadMinistryKey, setLeadMinistryKey] = useState<string | null>(null);
  const [sectors, setSectors] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [mediaListKeys, setMediaListKeys] = useState<string[]>([]);

  const [activityText, setActivityText] = useState(() => searchParams.get("activity") ?? "");
  const [location, setLocation] = useState("");
  const [publishAt, setPublishAt] = useState<string | null>(null);
  // From the Forecast's "Start a release": fill in from that activity once it's looked up.
  const [fillOnLookup, setFillOnLookup] = useState(() => searchParams.has("activity"));
  // An automatic fill (arriving from the Forecast, or a later lookup while fillOnLookup is still
  // set) never overwrites a field the user has already touched by hand. The explicit "Fill in
  // from activity N" button is a deliberate request, so it overwrites every field, touched or
  // not (see fillIn's force option below).
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (field: string) => setTouchedFields((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  // The activity id the fields below were last filled in from (or null, before any fill). When
  // the Activity ID field moves away from this id -- retyped or cleared -- the effect below
  // clears whatever it set that the user hasn't touched, so a stale pre-fill never survives a
  // change of activity.
  const [prefilledFrom, setPrefilledFrom] = useState<number | null>(null);
  const activityId = activityIdOf(activityText);
  const { lookup, error: lookupError } = useActivityLookup(activityId);
  const prefill = lookup?.state === "found" ? lookup.prefill : null;

  const [pageTypes, setPageTypes] = useState<PageTypeOption[]>([]);
  const [pageImages, setPageImages] = useState<PageImageOption[]>([]);
  const [categories, setCategories] = useState<Categories>(EMPTY_CATEGORIES);
  const [mediaLists, setMediaLists] = useState<MediaListOption[]>([]);

  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  // Minors: /page-types failing, or coming back empty, used to leave the Page title picker
  // silently empty with no way to tell why the form can't be filled in. `pageTypesLoaded`
  // distinguishes "still loading" (pageTypes also starts as []) from "loaded, but empty".
  const [pageTypesError, setPageTypesError] = useState<string | null>(null);
  const [pageTypesLoaded, setPageTypesLoaded] = useState(false);

  useEffect(() => {
    apiFetch<PageTypeOption[]>("/nrms/api/page-types").then(
      (types) => {
        setPageTypes(types);
        setPageTypesLoaded(true);
      },
      () => setPageTypesError("Couldn't load page types."),
    );
    apiFetch<PageImageOption[]>("/nrms/api/page-images").then(setPageImages, () => {});
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {});
    // GET /media-lists also returns retired lists (NRMS's own admin screen needs those); the
    // composer only ever offers active ones.
    apiFetch<MediaListOption[]>("/nrms/api/media-lists").then((all) => setMediaLists(all.filter((l) => l.isActive)), () => {});
  }, []);

  // The automatic fill (arriving from the Forecast, or a later lookup while fillOnLookup is
  // still set) keeps the touchedFields guard -- it never overwrites a field the user already
  // edited. The explicit "Fill in from activity N" button (below) is a deliberate user action,
  // so it passes force: true and overwrites every field, touched or not.
  const fillIn = (p: ReleasePrefill, opts: { force?: boolean } = {}) => {
    const skip = (field: string) => !opts.force && touchedFields.has(field);
    if (!skip("ministries")) {
      setMinistries(p.ministries);
      setLeadMinistryKey(p.leadMinistryKey);
    }
    if (!skip("sectors")) setSectors(p.sectors);
    if (!skip("themes")) setThemes(p.themes);
    if (!skip("tags")) setTags(p.tags);
    if (!skip("location")) setLocation(p.location);
    if (!skip("publishAt")) setPublishAt(p.publishAt);
    if (activityId !== null) setPrefilledFrom(activityId);
  };

  useEffect(() => {
    if (!fillOnLookup || !lookup) return;
    setFillOnLookup(false);
    if (prefill) fillIn(prefill);
  }, [fillOnLookup, lookup, prefill]);

  // A change (or clearing) of the Activity ID clears whatever the last fill set that the
  // user hasn't touched -- never a touched field, and never anything before the first fill.
  useEffect(() => {
    if (prefilledFrom === null || activityId === prefilledFrom) return;
    if (!touchedFields.has("ministries")) {
      setMinistries([]);
      setLeadMinistryKey(null);
    }
    if (!touchedFields.has("sectors")) setSectors([]);
    if (!touchedFields.has("themes")) setThemes([]);
    if (!touchedFields.has("tags")) setTags([]);
    if (!touchedFields.has("location")) setLocation("");
    if (!touchedFields.has("publishAt")) setPublishAt(null);
    setPrefilledFrom(null);
  }, [activityId, prefilledFrom, touchedFields]);

  // Fix round 1, finding 1: this route had no role gate at all — a Viewer or Site Editor
  // (anyone who can merely *read* releases) got a live creation form. Only NRMS.Editor may.
  if (!session.has("NRMS.Editor")) {
    return (
      <div className="gcpe-new-release">
        <h1>You don&rsquo;t have permission to create releases</h1>
        <p>Creating a release needs the Editor role.</p>
        <Link to="/releases/drafts">Back to releases</Link>
      </div>
    );
  }

  const rules = typeRules(type);
  const pageTitleOptions = pageTypes.filter((pt) => pt.releaseType === type && pt.languageId === LANG_EN).sort((a, b) => a.sortOrder - b.sortOrder);

  const onTypeChange = (next: CreatableType) => {
    setType(next);
    const nextRules = typeRules(next);
    if (!nextRules.pageImageAllowed) setPageImageId(null);
    if (!nextRules.categoriesBeyondMinistries) {
      setSectors([]);
      setThemes([]);
      setTags([]);
    }
    if (!nextRules.mediaListsAllowed) setMediaListKeys([]);
  };

  const onPageTitleChange = (value: string) => {
    setPageTitle(value);
    const opt = pageTitleOptions.find((pt) => pt.pageTitle === value);
    if (opt) {
      setLayout(opt.layout);
      setPageImageId(opt.pageImageId);
    }
  };

  const toggle = (list: string[], setList: (v: string[]) => void, key: string, field?: string) => {
    if (field) touch(field);
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  };

  const onMinistryToggle = (key: string) => {
    touch("ministries");
    const next = ministries.includes(key) ? ministries.filter((k) => k !== key) : [...ministries, key];
    setMinistries(next);
    if (!next.includes(leadMinistryKey ?? "")) setLeadMinistryKey(next.length === 1 ? next[0]! : null);
  };

  const buildInput = () => ({
    type,
    pageTitle,
    layout,
    pageImageId: rules.pageImageAllowed ? pageImageId : null,
    headline,
    subheadline: null,
    organizations: null,
    byline: null,
    bodyHtml: "",
    location,
    contacts: [],
    ministries,
    leadMinistryKey,
    sectors: rules.categoriesBeyondMinistries ? sectors : [],
    themes: rules.categoriesBeyondMinistries ? themes : [],
    tags: rules.categoriesBeyondMinistries ? tags : [],
    mediaListKeys: rules.mediaListsAllowed ? mediaListKeys : [],
    activityId: activityText.trim() === "" ? null : activityText.trim(),
    publishAt,
  });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblems({});

    const parsed = createReleaseSchema.safeParse(buildInput());
    if (!parsed.success) {
      const grouped: Record<string, string[]> = {};
      for (const i of parsed.error.issues as ZodIssue[]) {
        const field = typeof i.path[0] === "string" ? i.path[0] : "general";
        const text = issueText(field, i);
        if (!grouped[field]?.includes(text)) (grouped[field] ??= []).push(text);
      }
      setProblems(grouped);
      return;
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<ReleaseView>("/nrms/api/releases", { method: "POST", body: parsed.data });
      navigate(`/releases/${created.id}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 422) {
        setProblems(groupByField(caught.problems ?? [caught.message]));
      } else {
        setProblems({ general: [caught instanceof ApiError ? caught.message : "Couldn't create the release."] });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fieldProblem = (field: string): string | undefined => problems[field]?.join(" ");
  const problemList = Object.entries(problems).flatMap(([field, list]) => list.map((message) => ({ field, message })));

  return (
    <div className="gcpe-new-release">
      <h1>New release</h1>

      <ErrorSummary problems={problemList} />

      <Form onSubmit={onSubmit} validationBehavior="aria" className="gcpe-stack">
        <div className="gcpe-field-row">
          <label className="gcpe-field">
            Type
            <select id={FIELD_IDS.type} value={type} onChange={(e) => onTypeChange(e.target.value as CreatableType)}>
              {CREATABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>

          <label className="gcpe-field">
            Page title
            <select id={FIELD_IDS.pageTitle} value={pageTitle} aria-invalid={!!fieldProblem("pageTitle") || undefined} onChange={(e) => onPageTitleChange(e.target.value)}>
              <option value="">(choose one)</option>
              {pageTitleOptions.map((pt) => (
                <option key={pt.pageTitle} value={pt.pageTitle}>
                  {pt.pageTitle}
                </option>
              ))}
            </select>
          </label>
          <label className="gcpe-field">
            Layout
            <select id={FIELD_IDS.layout} value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
              {LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {l === "formal" ? "Formal" : "Informal"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {pageTypesError && <InlineAlert variant="danger" role="alert" description={pageTypesError} />}
        {!pageTypesError && pageTypesLoaded && pageTypes.length === 0 && (
          <InlineAlert variant="warning" role="alert" description="No page titles are set up yet. An administrator adds them under Release page titles." />
        )}
        {fieldProblem("pageTitle") && <p className="gcpe-field-error">{fieldProblem("pageTitle")}</p>}

        {rules.pageImageAllowed && (
          <fieldset className="gcpe-options" id={FIELD_IDS.pageImageId} tabIndex={-1}>
            <legend>Page image</legend>
            <label>
              <input type="radio" name="pageImage" checked={pageImageId === null} onChange={() => setPageImageId(null)} />
              (none)
            </label>
            {pageImages.map((img) => (
              <label key={img.id}>
                <input type="radio" name="pageImage" checked={pageImageId === img.id} onChange={() => setPageImageId(img.id)} />
                <img src={`/nrms/api/page-images/${img.id}/image`} alt={img.name} width={60} height={40} />
                {img.name}
              </label>
            ))}
          </fieldset>
        )}
        {fieldProblem("pageImageId") && <p className="gcpe-field-error">{fieldProblem("pageImageId")}</p>}

        <TextField id={FIELD_IDS.headline} label="Headline" value={headline} onChange={setHeadline} isRequired errorMessage={fieldProblem("headline")} isInvalid={!!fieldProblem("headline")} />

        <TextField
          id={FIELD_IDS.activityId}
          label="Activity ID"
          value={activityText}
          onChange={setActivityText}
          inputMode="numeric"
          maxLength={10}
          errorMessage={fieldProblem("activityId")}
          isInvalid={!!fieldProblem("activityId")}
        />
        <ActivityLookupPanel lookup={lookup} error={lookupError} storedId={null} timeZone={timeZone} />
        {prefill && activityId !== null && (
          <Button variant="secondary" onPress={() => fillIn(prefill, { force: true })}>
            Fill in from activity {activityId}
          </Button>
        )}

        <TextField
          id={FIELD_IDS.location}
          label="Location"
          value={location}
          onChange={(v) => {
            touch("location");
            setLocation(v);
          }}
          maxLength={50}
        />
        {publishAt && <p>Planned publish date: {dateTimeText(publishAt, timeZone)}, from the activity. Change it in Publish settings.</p>}

        <fieldset className="gcpe-options" id={FIELD_IDS.ministries} tabIndex={-1}>
          <legend>Ministries</legend>
          {categories.ministries.map((m) => (
            <label key={m.key}>
              <input type="checkbox" checked={ministries.includes(m.key)} onChange={() => onMinistryToggle(m.key)} />
              {m.name}
            </label>
          ))}
        </fieldset>
        {fieldProblem("ministries") && <p className="gcpe-field-error">{fieldProblem("ministries")}</p>}

        {ministries.length > 1 && (
          <label className="gcpe-field">
            Lead ministry
            <select
              id={FIELD_IDS.leadMinistryKey}
              value={leadMinistryKey ?? ""}
              onChange={(e) => {
                touch("ministries");
                setLeadMinistryKey(e.target.value || null);
              }}
            >
              <option value="">(none)</option>
              {ministries.map((key) => (
                <option key={key} value={key}>
                  {categories.ministries.find((m) => m.key === key)?.name ?? key}
                </option>
              ))}
            </select>
          </label>
        )}

        {rules.categoriesBeyondMinistries && (
          <>
            <fieldset className="gcpe-options" id={FIELD_IDS.sectors} tabIndex={-1}>
              <legend>Sectors</legend>
              {categories.sectors.map((s) => (
                <label key={s.key}>
                  <input type="checkbox" checked={sectors.includes(s.key)} onChange={() => toggle(sectors, setSectors, s.key, "sectors")} />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <fieldset className="gcpe-options" id={FIELD_IDS.themes} tabIndex={-1}>
              <legend>Themes</legend>
              {categories.themes.map((t) => (
                <label key={t.key}>
                  <input type="checkbox" checked={themes.includes(t.key)} onChange={() => toggle(themes, setThemes, t.key, "themes")} />
                  {t.name}
                </label>
              ))}
            </fieldset>
            <fieldset className="gcpe-options" id={FIELD_IDS.tags} tabIndex={-1}>
              <legend>Tags</legend>
              {categories.tags.map((t) => (
                <label key={t.key}>
                  <input type="checkbox" checked={tags.includes(t.key)} onChange={() => toggle(tags, setTags, t.key, "tags")} />
                  {t.name}
                </label>
              ))}
            </fieldset>
          </>
        )}

        {rules.mediaListsAllowed && (
          <fieldset className="gcpe-options" id={FIELD_IDS.mediaListKeys} tabIndex={-1}>
            <legend>
              Media distribution lists{rules.mediaListRequired ? " (required)" : ""}
            </legend>
            {mediaLists.map((l) => (
              <label key={l.key}>
                <input type="checkbox" checked={mediaListKeys.includes(l.key)} onChange={() => toggle(mediaListKeys, setMediaListKeys, l.key)} />
                {l.displayName}
              </label>
            ))}
          </fieldset>
        )}
        {fieldProblem("mediaListKeys") && <p className="gcpe-field-error">{fieldProblem("mediaListKeys")}</p>}

        <Button type="submit" isPending={submitting} pendingLabel="Creating…">
          Create release
        </Button>
      </Form>
    </div>
  );
}
