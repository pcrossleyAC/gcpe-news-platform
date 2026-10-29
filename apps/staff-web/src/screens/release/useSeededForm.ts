import { useState } from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface SeededForm<T> {
  form: T;
  setForm: React.Dispatch<React.SetStateAction<T>>;
  /** The form differs from the value it was last seeded from — the user's own edits, never
   * a change someone (or something) else made to the release. */
  dirty: boolean;
  /** The value the form was last seeded from. */
  baseline: T;
  /** Seeds form and baseline from this value (after this section's own save or a Reload). */
  reseed(next: T): void;
}

/**
 * A release editor section's form state, compared against the value it was seeded from (its
 * baseline) rather than against the live `view`. The page's `view` changes under a section all
 * the time: another section's save, a background refresh, Approve assigning a key and a
 * reference, Publish now or Schedule setting `publishAt`, another section's 409 Reload bringing
 * in someone else's edits. Compared against `view`, each of those would read as an unsaved edit
 * here (blocking Publish now with "Save your changes…", and a save would send stale values
 * back). Instead: whenever the value derived from `view` (`seed`) changes and the form still
 * equals its old baseline (the user hasn't touched it), the form is re-seeded from the new
 * value; if the user has edited it, their edits and the baseline they started from are kept.
 *
 * The re-seed happens during render (React's "adjust state when a prop changes" pattern), not
 * in an effect, so no render ever sees a stale form as dirty — the unsaved-changes guard never
 * flickers, announces or blocks for it.
 *
 * `initialForm` (optional) seeds the form with something other than `seed` — a restored
 * session-expiry draft — while the baseline stays `seed`, so the restored draft counts as dirty.
 */
export function useSeededForm<T>(seed: T, initialForm?: () => T): SeededForm<T> {
  const [form, setForm] = useState<T>(() => (initialForm ? initialForm() : seed));
  const [baseline, setBaseline] = useState<T>(seed);
  const [lastSeed, setLastSeed] = useState<T>(seed);

  let current = form;
  let base = baseline;
  if (!same(seed, lastSeed)) {
    setLastSeed(seed);
    // Clean: follow the new value. Edited: keep the user's edits, measured against what they
    // started from.
    if (same(form, baseline)) {
      setForm(seed);
      setBaseline(seed);
      current = seed;
      base = seed;
    }
  }

  const reseed = (next: T) => {
    setForm(next);
    setBaseline(next);
    setLastSeed(next);
  };

  return { form: current, setForm, dirty: !same(current, base), baseline: base, reseed };
}
