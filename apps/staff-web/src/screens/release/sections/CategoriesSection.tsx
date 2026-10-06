import { useEffect, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert } from "@bcgov/design-system-react-components";
import { typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";
import type { Categories, Term } from "../categories";
import { FeatureSwitches, type FeaturePlace } from "./FeatureSwitches";

export interface CategoriesSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

type CategoryKind = "ministries" | "sectors" | "themes" | "tags";

interface FormState {
  leadMinistryKey: string | null;
  ministries: string[];
  sectors: string[];
  themes: string[];
  tags: string[];
}

function fromView(view: ReleaseView): FormState {
  return { leadMinistryKey: view.leadMinistryKey, ministries: view.ministries, sectors: view.sectors, themes: view.themes, tags: view.tags };
}

const EMPTY_CATEGORIES: Categories = { ministries: [], sectors: [], themes: [], tags: [] };
const nameOf = (list: Term[], key: string): string => list.find((t) => t.key === key)?.name ?? key;

/**
 * Spec's "Categories" section (`PUT .../categories`) plus the Top/Feature switches for Home and
 * every ministry/sector/theme this release is *currently* (as saved) filed under — the switches
 * act on `view`, never on this form's own unsaved picks, since `POST .../features` only makes
 * sense for categories the release has actually been saved into.
 */
export function CategoriesSection({ view, setView, readOnly }: CategoriesSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);
  const [categories, setCategories] = useState<Categories>(EMPTY_CATEGORIES);
  const [form, setForm] = useState<FormState>(() => fromView(view));

  useEffect(() => {
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {
      // The checkbox lists just won't be offered — the rest of the page still works.
    });
  }, []);

  const dirty = !readOnly && JSON.stringify(form) !== JSON.stringify(fromView(view));

  const toggle = (kind: CategoryKind, key: string) =>
    setForm((f) => {
      const next = f[kind].includes(key) ? f[kind].filter((k) => k !== key) : [...f[kind], key];
      const patch: Partial<FormState> = { [kind]: next };
      if (kind === "ministries" && !next.includes(f.leadMinistryKey ?? "")) patch.leadMinistryKey = next.length === 1 ? next[0]! : null;
      return { ...f, ...patch };
    });

  const doSave = () =>
    section.save("/categories", { version: view.version, ...form }).then((next) => {
      if (next) setForm(fromView(next));
    });
  useRegisterDirty("categories", dirty, !readOnly ? { label: "Save categories", save: doSave } : undefined);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void doSave();
  };

  const places: FeaturePlace[] = [
    { kind: "home", key: "default", label: "Home" },
    ...view.ministries.map((key) => ({ kind: "ministries" as const, key, label: nameOf(categories.ministries, key) })),
    ...view.sectors.map((key) => ({ kind: "sectors" as const, key, label: nameOf(categories.sectors, key) })),
    ...view.themes.map((key) => ({ kind: "themes" as const, key, label: nameOf(categories.themes, key) })),
  ];

  const categoryList = (kind: CategoryKind, legend: string, terms: Term[]) => (
    <fieldset>
      <legend>{legend}</legend>
      {terms.map((t) => (
        <label key={t.key}>
          <input type="checkbox" checked={form[kind].includes(t.key)} disabled={readOnly} onChange={() => toggle(kind, t.key)} />
          {t.name}
        </label>
      ))}
    </fieldset>
  );

  return (
    <section className="gcpe-release-editor__categories" aria-label="Categories" id="section-categories" tabIndex={-1}>
      <h2>Categories</h2>

      {section.conflict && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={RELOAD_MESSAGE}
          buttons={
            <Button
              onPress={() =>
                void section.reload().then((next) => setForm(fromView(next)))
              }
            >
              Reload
            </Button>
          }
        />
      )}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <Form onSubmit={onSubmit}>
        {categoryList("ministries", "Ministries", categories.ministries)}

        {form.ministries.length > 1 && (
          <label>
            Lead ministry
            <select value={form.leadMinistryKey ?? ""} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, leadMinistryKey: e.target.value || null }))}>
              <option value="">(none)</option>
              {form.ministries.map((key) => (
                <option key={key} value={key}>
                  {nameOf(categories.ministries, key)}
                </option>
              ))}
            </select>
          </label>
        )}

        {rules.categoriesBeyondMinistries && (
          <>
            {categoryList("sectors", "Sectors", categories.sectors)}
            {categoryList("themes", "Themes", categories.themes)}
            {categoryList("tags", "Tags", categories.tags)}
          </>
        )}

        {!readOnly && (
          <Button type="submit" isDisabled={section.saving}>
            Save categories
          </Button>
        )}
      </Form>

      <FeatureSwitches view={view} setView={setView} places={places} readOnly={readOnly} />
    </section>
  );
}
