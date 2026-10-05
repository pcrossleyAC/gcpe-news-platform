import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { CREATABLE_TYPES, LANG_EN, LAYOUTS, TYPE_LABEL, createReleaseSchema, typeRules, type Layout, type ReleaseView } from "@gcpe/nrms-contract";
import type { ZodIssue } from "zod";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
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
  id: string;
  key: string;
  name: string;
}

const EMPTY_CATEGORIES: Categories = { ministries: [], sectors: [], themes: [], tags: [] };

/** Maps one of the server's free-text problem strings (422 `problems`, or a client-side zod
 * issue's `path`) to the field it's about — acceptance: "the API's 422 problems map to fields".
 * Anything unrecognised falls back to "general" (shown as a page-level alert, not lost). */
function fieldFor(problem: string): string {
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

/**
 * `/hub/releases/new` (task-3-brief.md): type, page title (from `GET /page-types`), layout,
 * page image (`GET /page-images`), categories, and headline — the fields shown and required
 * change per {@link typeRules}. Validates client-side with `createReleaseSchema` before
 * sending; on success, `POST /nrms/api/releases` and navigate to the new release's editor.
 */
export function NewReleaseScreen(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
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

  const [pageTypes, setPageTypes] = useState<PageTypeOption[]>([]);
  const [pageImages, setPageImages] = useState<PageImageOption[]>([]);
  const [categories, setCategories] = useState<Categories>(EMPTY_CATEGORIES);
  const [mediaLists, setMediaLists] = useState<MediaListOption[]>([]);

  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch<PageTypeOption[]>("/nrms/api/page-types").then(setPageTypes, () => {});
    apiFetch<PageImageOption[]>("/nrms/api/page-images").then(setPageImages, () => {});
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {});
    apiFetch<MediaListOption[]>("/nrms/api/media-lists").then(setMediaLists, () => {});
  }, []);

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

  const toggle = (list: string[], setList: (v: string[]) => void, key: string) => setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const onMinistryToggle = (key: string) => {
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
    location: "",
    contacts: [],
    ministries,
    leadMinistryKey,
    sectors: rules.categoriesBeyondMinistries ? sectors : [],
    themes: rules.categoriesBeyondMinistries ? themes : [],
    tags: rules.categoriesBeyondMinistries ? tags : [],
    mediaListKeys: rules.mediaListsAllowed ? mediaListKeys : [],
    activityId: null,
    publishAt: null,
  });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblems({});

    const parsed = createReleaseSchema.safeParse(buildInput());
    if (!parsed.success) {
      const grouped: Record<string, string[]> = {};
      for (const i of parsed.error.issues as ZodIssue[]) {
        const field = typeof i.path[0] === "string" ? i.path[0] : "general";
        (grouped[field] ??= []).push(i.message);
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

  return (
    <div className="gcpe-new-release">
      <h1>New release</h1>

      {problems.general && (
        <InlineAlert variant="danger" role="alert" description={problems.general.join(" ")} />
      )}

      <Form onSubmit={onSubmit} validationBehavior="aria">
        <label>
          Type
          <select value={type} onChange={(e) => onTypeChange(e.target.value as CreatableType)}>
            {CREATABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label>
          Page title
          <select value={pageTitle} onChange={(e) => onPageTitleChange(e.target.value)}>
            <option value="">(choose one)</option>
            {pageTitleOptions.map((pt) => (
              <option key={pt.pageTitle} value={pt.pageTitle}>
                {pt.pageTitle}
              </option>
            ))}
          </select>
        </label>
        {fieldProblem("pageTitle") && <p role="alert">{fieldProblem("pageTitle")}</p>}

        <label>
          Layout
          <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {l === "formal" ? "Formal" : "Informal"}
              </option>
            ))}
          </select>
        </label>

        {rules.pageImageAllowed && (
          <fieldset>
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
        {fieldProblem("pageImageId") && <p role="alert">{fieldProblem("pageImageId")}</p>}

        <TextField label="Headline" value={headline} onChange={setHeadline} isRequired errorMessage={fieldProblem("headline")} isInvalid={!!fieldProblem("headline")} />

        <fieldset>
          <legend>Ministries</legend>
          {categories.ministries.map((m) => (
            <label key={m.key}>
              <input type="checkbox" checked={ministries.includes(m.key)} onChange={() => onMinistryToggle(m.key)} />
              {m.name}
            </label>
          ))}
        </fieldset>
        {fieldProblem("ministries") && <p role="alert">{fieldProblem("ministries")}</p>}

        {ministries.length > 1 && (
          <label>
            Lead ministry
            <select value={leadMinistryKey ?? ""} onChange={(e) => setLeadMinistryKey(e.target.value || null)}>
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
            <fieldset>
              <legend>Sectors</legend>
              {categories.sectors.map((s) => (
                <label key={s.key}>
                  <input type="checkbox" checked={sectors.includes(s.key)} onChange={() => toggle(sectors, setSectors, s.key)} />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Themes</legend>
              {categories.themes.map((t) => (
                <label key={t.key}>
                  <input type="checkbox" checked={themes.includes(t.key)} onChange={() => toggle(themes, setThemes, t.key)} />
                  {t.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Tags</legend>
              {categories.tags.map((t) => (
                <label key={t.key}>
                  <input type="checkbox" checked={tags.includes(t.key)} onChange={() => toggle(tags, setTags, t.key)} />
                  {t.name}
                </label>
              ))}
            </fieldset>
          </>
        )}

        {rules.mediaListsAllowed && (
          <fieldset>
            <legend>
              Media distribution lists{rules.mediaListRequired ? " (required)" : ""}
            </legend>
            {mediaLists.map((l) => (
              <label key={l.id}>
                <input type="checkbox" checked={mediaListKeys.includes(l.key)} onChange={() => toggle(mediaListKeys, setMediaListKeys, l.key)} />
                {l.name}
              </label>
            ))}
          </fieldset>
        )}
        {fieldProblem("mediaListKeys") && <p role="alert">{fieldProblem("mediaListKeys")}</p>}

        <Button type="submit" isDisabled={submitting}>
          Create release
        </Button>
      </Form>
    </div>
  );
}
