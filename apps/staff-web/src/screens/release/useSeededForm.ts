import { useState } from "react";
import { useSaveQueue } from "./saveQueue";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `form` re-based from `baseline` onto `seed`, or null when a field the user edited was also
 * changed to something else by someone other than this page (`ours` false): a real conflict. */
function mergeFields<T>(form: T, baseline: T, seed: T, ours: boolean): T | null {
  if (!isRecord(form) || !isRecord(baseline) || !isRecord(seed)) return null;
  const merged: Record<string, unknown> = { ...form };
  for (const k of Object.keys(seed)) {
    if (same(seed[k], baseline[k])) continue;
    if (same(form[k], baseline[k])) merged[k] = seed[k];
    else if (!same(form[k], seed[k]) && !ours) return null;
  }
  return merged as T;
}

export interface SeededForm<T> {
  form: T;
  setForm: React.Dispatch<React.SetStateAction<T>>;
  /** The form differs from the value it was last seeded from — the user's own edits, never
   * a change someone (or something) else made to the release. */
  dirty: boolean;
  /** The value the form was last seeded from. */
  baseline: T;
  /** Seeds form and baseline from this value, at this release version (after this section's
   * own save, or a Reload). */
  reseed(next: T, version: number): void;
  /** The release version to save with when this section's own fields changed on the server
   * while the user was editing them: the last version at which the server still held what they
   * started from. Saving with it gets a 409 (someone else changed this — reload) instead of
   * silently overwriting the other change. Null otherwise: save with the latest version. */
  staleVersion: number | null;
}

/**
 * A release editor section's form state, compared against the value it was seeded from (its
 * baseline) rather than against the live `view`. The page's `view` changes under a section all
 * the time: another section's save, a background refresh, Approve assigning a key and a
 * reference, Publish now or Schedule setting `publishAt`, another section's 409 Reload bringing
 * in someone else's edits. Compared against `view`, each of those would read as an unsaved edit
 * here (blocking Publish now with "Save your changes…", and a save would send stale values
 * back).
 *
 * Instead, `seed` (this section's values derived from the current `view`) is checked on every
 * render:
 *  - The form equals its baseline (untouched, or the user took their edits back out) but the
 *    release now holds something else: the form re-seeds from the release.
 *  - The user has edits: they stay, measured against what they started from. If the release's
 *    values for this section are still that baseline, saving uses the latest version as usual.
 *    If they've changed underneath, it's merged field by field: fields the user didn't touch take
 *    the new value; a field both changed keeps the user's value when the change was this page's
 *    own save (saveQueue's isOwnChange), and otherwise {@link SeededForm.staleVersion} makes the
 *    save a conflict (someone else changed that same field).
 *
 * The re-seed happens during render (React's "adjust state when a prop changes" pattern), not in
 * an effect, so no render ever sees a stale form as dirty — the unsaved-changes guard never
 * flickers, announces or blocks for it.
 *
 * `initialForm` (optional) seeds the form with something other than `seed` — a restored
 * session-expiry draft — while the baseline stays `seed`, so the restored draft counts as dirty.
 */
export function useSeededForm<T>(seed: T, version: number, initialForm?: () => T): SeededForm<T> {
  const queue = useSaveQueue();
  const [form, setForm] = useState<T>(() => (initialForm ? initialForm() : seed));
  const [baseline, setBaseline] = useState<T>(seed);
  // The latest version at which the release's values for this section still equal `baseline`.
  const [baselineVersion, setBaselineVersion] = useState(version);

  let current = form;
  let base = baseline;
  let baseVersion = baselineVersion;
  if (same(seed, baseline)) {
    if (version !== baselineVersion) {
      setBaselineVersion(version);
      baseVersion = version;
    }
  } else if (same(form, baseline)) {
    setForm(seed);
    setBaseline(seed);
    setBaselineVersion(version);
    current = seed;
    base = seed;
    baseVersion = version;
  } else {
    // Both moved: the user has edits and the release's values for this section changed too.
    // Field by field: a field the user didn't touch takes the release's new value; a field they
    // did touch keeps their value. That's only a conflict when someone else changed that same
    // field — when the change came from this page's own save (saving a document regenerates the
    // summary and, for a story, the key), the user's later edit wins. No conflict: the form
    // re-bases on the release as it is now and saves with the latest version.
    const merged = mergeFields(form, baseline, seed, queue.isOwnChange(baselineVersion, version));
    if (merged !== null) {
      setForm(merged);
      setBaseline(seed);
      setBaselineVersion(version);
      current = merged;
      base = seed;
      baseVersion = version;
    }
  }

  const reseed = (next: T, nextVersion: number) => {
    setForm(next);
    setBaseline(next);
    setBaselineVersion(nextVersion);
  };

  const dirty = !same(current, base);
  return { form: current, setForm, dirty, baseline: base, reseed, staleVersion: dirty && !same(seed, base) ? baseVersion : null };
}
