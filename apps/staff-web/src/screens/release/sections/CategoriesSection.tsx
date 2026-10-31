import { useEffect, useState, type FormEvent } from "react";
import { Form, InlineAlert } from "@bcgov/design-system-react-components";
import { typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { UnsavedMarker } from "../UnsavedMarker";
import { LeadMinistrySelect } from "../LeadMinistrySelect";
import { useRegisterDirty, useSaveAll } from "../useUnsavedChanges";
import { useSeededForm } from "../useSeededForm";
import type { Categories, Term } from "../categories";
import { SectionDisclosure } from "../../../shared/SectionDisclosure";
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
  const { form, setForm, dirty: edited, reseed, staleVersion } = useSeededForm<FormState>(fromView(view), view.version);

  useEffect(() => {
    apiFetch<Categories>("/nrms/api/categories").then(setCategories, () => {
      // The checkbox lists just won't be offered — the rest of the page still works.
    });
  }, []);

  const dirty = !readOnly && edited;

  const toggle = (kind: CategoryKind, key: string) =>
    setForm((f) => {
      const next = f[kind].includes(key) ? f[kind].filter((k) => k !== key) : [...f[kind], key];
      const patch: Partial<FormState> = { [kind]: next };
      if (kind === "ministries" && !next.includes(f.leadMinistryKey ?? "")) patch.leadMinistryKey = next.length === 1 ? next[0]! : null;
      return { ...f, ...patch };
    });

  const doSave = () =>
    section.save("/categories", { version: view.version, ...form }, "PUT", staleVersion, { quiet: true }).then((next) => {
      if (next) reseed(fromView(next), next.version);
      return next !== null;
    });
  useRegisterDirty("categories", dirty, !readOnly ? { label: "Save categories", save: doSave } : undefined);

  // Enter in a field saves the page, the same as its one Save.
  const saveAll = useSaveAll();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    saveAll();
  };

  const places: FeaturePlace[] = [
    { kind: "home", key: "default", label: "Home" },
    ...view.ministries.map((key) => ({ kind: "ministries" as const, key, label: nameOf(categories.ministries, key) })),
    ...view.sectors.map((key) => ({ kind: "sectors" as const, key, label: nameOf(categories.sectors, key) })),
    ...view.themes.map((key) => ({ kind: "themes" as const, key, label: nameOf(categories.themes, key) })),
  ];

  // The closed disclosure's one line: what's picked right now (unsaved picks included).
  const pickedText = (kind: CategoryKind, terms: Term[]) => {
    const names = form[kind].map((k) => (kind === "ministries" && k === form.leadMinistryKey && form.ministries.length > 1 ? `${nameOf(terms, k)} (lead)` : nameOf(terms, k)));
    return names.length > 0 ? names.join(", ") : "none";
  };
  const summary = (
    <>
      <strong>Ministries:</strong> {pickedText("ministries", categories.ministries)}
      {rules.categoriesBeyondMinistries && (
        <>
          {" · "}
          <strong>Sectors:</strong> {pickedText("sectors", categories.sectors)}
          {" · "}
          <strong>Themes:</strong> {pickedText("themes", categories.themes)}
          {" · "}
          <strong>Tags:</strong> {pickedText("tags", categories.tags)}
        </>
      )}
    </>
  );

  const categoryList = (kind: CategoryKind, legend: string, terms: Term[]) => (
    <fieldset className="gcpe-options">
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
    <>
      <section className="gcpe-release-editor__categories" aria-label="Categories" id="section-categories" tabIndex={-1}>
        <h2>
          Categories<UnsavedMarker show={dirty} />
        </h2>

        {section.conflict && (
          <InlineAlert
            variant="danger"
            role="alert"
            description={RELOAD_MESSAGE}
            buttons={
              <Button
                onPress={() =>
                  void section.reload().then((next) => reseed(fromView(next), next.version))
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
        {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

        <SectionDisclosure label={readOnly ? "Show categories" : "Edit categories"} summary={summary}>
          <Form onSubmit={onSubmit} className="gcpe-stack">
            {categoryList("ministries", "Ministries", categories.ministries)}

            {form.ministries.length > 1 && (
              <LeadMinistrySelect
                value={form.leadMinistryKey}
                ministries={form.ministries.map((key) => ({ key, name: nameOf(categories.ministries, key) }))}
                needed={view.type !== "advisory"}
                readOnly={readOnly}
                beforeApproval={view.status === "draft"}
                onChange={(leadMinistryKey) => setForm((f) => ({ ...f, leadMinistryKey }))}
              />
            )}

            {rules.categoriesBeyondMinistries && (
              <>
                {categoryList("sectors", "Sectors", categories.sectors)}
                {categoryList("themes", "Themes", categories.themes)}
                {categoryList("tags", "Tags", categories.tags)}
              </>
            )}
          </Form>
        </SectionDisclosure>
      </section>

      {/* Its own card: the switches act on the release as saved, not on this form's picks. */}
      <FeatureSwitches view={view} setView={setView} places={places} readOnly={readOnly} />
    </>
  );
}
