import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldError, SectionKey, SiteSettings } from "@gcpe/site-settings";
import { ApiError } from "../../../api/client";
import { useAnnouncer } from "../../../shared/Announcer";
import { settingsScreenFor } from "../WebsiteScreen";
import {
  discardSettingsDraft,
  getSettings,
  publishSettings,
  rebaseSettings,
  saveSettingsDraft,
  type PublishConflict,
  type PublishInvalid,
  type SettingsState,
} from "./api";

/** Spec "Hub screens" statuses, verbatim. */
export const DRAFT_SAVED = "Draft saved. It isn't live until you publish.";
export const DRAFT_SAVED_WITH_PROBLEMS = "Draft saved, but it has problems to fix before it can be published.";
export const DRAFT_DISCARDED = "Draft discarded. Showing what is live.";
export const publishedStatus = (revision: number) => `Published revision ${revision}. Visitors see it within a few minutes.`;
/** W4: after "Publish only <screen>". */
export const publishedOnlyStatus = (revision: number, section: SectionKey, rest: readonly SectionKey[]) =>
  `Published revision ${revision}, with only your ${settingsScreenFor(section).label} changes. Visitors see it within a few minutes.${rest.length > 0 ? ` Your draft still has changes on ${sectionList(rest)}.` : ""}`;

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
/** The sections by their screens' names, as on screen: "Site banner", "Site banner and Theme colours", "Site banner, Theme colours, and Footer links". */
export const sectionList = (keys: readonly SectionKey[]) => LIST.format(keys.map((k) => settingsScreenFor(k).label));

/** The section a field error belongs to: `footer.moreInfoLinks[2].url` ⇒ `footer`. */
export const sectionOfField = (field: string) => field.split(/[.[]/, 1)[0] as SectionKey;

export type SettingsAction = "save" | "publish" | "discard" | "rebase";

/**
 * How a screen's form value maps to and from the document. The default is the section's own
 * value, unchanged — the Banner screen uses these to show its instants as BC wall-clock and to
 * send `startsAtLocal`/`endsAtLocal`.
 */
export interface SettingsEditorOptions<K extends SectionKey, F> {
  fromDocument(value: SiteSettings[K]): F;
  toRequest(form: F): unknown;
}

export interface SettingsEditor<F> {
  /** The section this screen edits. */
  section: SectionKey;
  state: SettingsState | null;
  loadError: string | null;
  /** The screen's form value; null until the first load. */
  value: F | null;
  setValue(next: F | ((prev: F) => F)): void;
  saveDraft(): Promise<void>;
  /** Resolves true when published (the caller then clears its note). With `onlySection` (W4), only
   * this screen's section goes live and the rest of the draft is kept. */
  publish(note: string, onlySection?: boolean, announceLater?: (announceNow: () => void) => void): Promise<boolean>;
  discard(): Promise<void>;
  rebase(): Promise<void>;
  status: string | null;
  /** Attach to the element showing {@link status}: focus moves there when an action removes the button that started it. */
  statusRef: React.RefObject<HTMLParagraphElement | null>;
  /** A failure that isn't a validation problem or a conflict (network, 400, 500). */
  error: string | null;
  /** Problems in this screen's section (field starts with `"<section>."`). */
  fieldErrors: FieldError[];
  /** Problems elsewhere in the draft, for {@link OtherSectionErrors}. */
  otherErrors: FieldError[];
  conflict: PublishConflict | null;
  /** The form differs from what the state holds for this section (typed but not saved). */
  dirty: boolean;
  /** The action in flight, if any. */
  pending: SettingsAction | null;
  busy: boolean;
}

const identity = <K extends SectionKey>(): SettingsEditorOptions<K, SiteSettings[K]> => ({ fromDocument: (v) => v, toRequest: (v) => v });

/**
 * One screen's share of the site-settings draft (spec "Hub screens"): loads the editor's
 * state, then Save draft / Publish / Discard / Rebase this section only. Every successful
 * action shows the state the server returned — so the form (and every error index in it)
 * matches what was saved — and announces its status.
 */
export function useSettingsEditor<K extends SectionKey, F = SiteSettings[K]>(section: K, options?: SettingsEditorOptions<K, F>): SettingsEditor<F> {
  const optionsRef = useRef((options ?? identity<K>()) as SettingsEditorOptions<K, F>);
  optionsRef.current = (options ?? identity<K>()) as SettingsEditorOptions<K, F>;
  const { announce } = useAnnouncer();

  const [state, setState] = useState<SettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setFormValue] = useState<F | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PublishConflict | null>(null);
  const [pending, setPending] = useState<SettingsAction | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusStatus, setFocusStatus] = useState(0);

  // Counts form edits. An action records the count when it starts; if the editor typed while
  // it was in flight, its result updates everything but the form, so the typing isn't lost.
  const edits = useRef(0);
  const editsAtSend = useRef(0);

  const show = useCallback(
    (next: SettingsState, nextErrors: FieldError[] = next.errors) => {
      setState(next);
      if (edits.current === editsAtSend.current) setFormValue(optionsRef.current.fromDocument(next.document[section]));
      setErrors(nextErrors);
    },
    [section],
  );

  useEffect(() => {
    let active = true;
    getSettings().then(
      (s) => active && show(s),
      () => active && setLoadError("Couldn't load the site settings."),
    );
    return () => {
      active = false;
    };
  }, [show]);

  useEffect(() => {
    if (focusStatus > 0) statusRef.current?.focus();
  }, [focusStatus]);

  // `announceLater` (M1): Publish starts as its confirmation closes, so its result is shown at once
  // but announced once the dialog has gone (a closing dialog hides the rest of the page).
  const announceLater = useRef<((announceNow: () => void) => void) | null>(null);
  const say = useCallback(
    (message: string, moveFocus = false) => {
      setStatus(message);
      const later = announceLater.current;
      if (later) later(() => announce(message));
      else announce(message);
      if (moveFocus) setFocusStatus((n) => n + 1);
    },
    [announce],
  );

  const run = async <T>(action: SettingsAction, body: () => Promise<T>): Promise<T | undefined> => {
    if (pending) return undefined;
    setPending(action);
    editsAtSend.current = edits.current;
    setError(null);
    setStatus(null);
    try {
      return await body();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong. Try again.");
      return undefined;
    } finally {
      setPending(null);
    }
  };

  const request = () => optionsRef.current.toRequest(value as F);

  const saveDraft = async () => {
    if (!state || value === null) return;
    await run("save", async () => {
      const next = await saveSettingsDraft({ baseRevision: state.baseRevision, section, value: request() });
      show(next);
      setConflict(null);
      say(next.errors.length > 0 ? DRAFT_SAVED_WITH_PROBLEMS : DRAFT_SAVED);
    });
  };

  const publish = async (note: string, onlySection = false, later?: (announceNow: () => void) => void) => {
    if (!state || value === null) return false;
    announceLater.current = later ?? null;
    const done = await run("publish", async () => {
      const trimmed = note.trim();
      try {
        const result = await publishSettings({ baseRevision: state.baseRevision, section, value: request(), ...(trimmed ? { note: trimmed } : {}), ...(onlySection ? { onlySection: true } : {}) });
        show(result.state);
        setConflict(null);
        say(onlySection ? publishedOnlyStatus(result.revision, section, result.state.draftSections) : publishedStatus(result.revision));
        return true;
      } catch (caught) {
        if (!(caught instanceof ApiError)) throw caught;
        // Both refusals saved the draft first: reload it, so the form and its error indexes
        // match what was saved (blank link rows dropped).
        if (caught.status === 422) {
          const invalid = caught.body as PublishInvalid;
          show(await getSettings(), invalid.fieldErrors);
          say(DRAFT_SAVED_WITH_PROBLEMS);
          return false;
        }
        if (caught.status === 409 && caught.code === "published") {
          const body = caught.body as PublishConflict;
          show(await getSettings());
          setConflict({ live: body.live, differing: body.differing });
          return false;
        }
        throw caught;
      }
    });
    announceLater.current = null;
    return done === true;
  };

  const discard = async () => {
    await run("discard", async () => {
      await discardSettingsDraft();
      show(await getSettings());
      setConflict(null);
      say(DRAFT_DISCARDED, true);
    });
  };

  const rebase = async () => {
    if (value === null) return;
    await run("rebase", async () => {
      const { alsoChangedByThem, ...next } = await rebaseSettings({ section, value: request() });
      show(next);
      setConflict(null);
      const revision = next.live?.revision ?? next.baseRevision;
      // Fix round 1: nothing of yours is set aside; changes they also made elsewhere are named.
      const alsoText = alsoChangedByThem.length > 0 ? ` Your draft still has your changes on ${sectionList(alsoChangedByThem)}, which they changed too: check them before you publish them.` : "";
      say(`Your ${settingsScreenFor(section).label.toLowerCase()} changes now build on revision ${revision}. Check them, then publish.${alsoText}`, true);
    });
  };

  const setValue = useCallback((next: F | ((prev: F) => F)) => {
    edits.current += 1;
    setFormValue((prev) => (prev === null ? prev : typeof next === "function" ? (next as (p: F) => F)(prev) : next));
  }, []);

  const prefix = `${section}.`;
  return {
    section,
    state,
    loadError,
    value,
    setValue,
    saveDraft,
    publish,
    discard,
    rebase,
    status,
    statusRef,
    error,
    fieldErrors: errors.filter((e) => e.field.startsWith(prefix)),
    otherErrors: errors.filter((e) => !e.field.startsWith(prefix)),
    conflict,
    dirty: state !== null && value !== null && JSON.stringify(request()) !== JSON.stringify(optionsRef.current.toRequest(optionsRef.current.fromDocument(state.document[section]))),
    pending,
    busy: pending !== null,
  };
}
