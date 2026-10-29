import { useState } from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A form field seeded from server data (the same idea as the release editor's useSeededForm, for
 * screens with no versions). When the server's value changes and the field still holds the value
 * it was seeded from, the field follows the new value, so a reload after any save never leaves a
 * stale copy that reads as an edit; once the user has edited it, their edit is kept. `dirty`
 * compares with that seed, never with the live value. Re-seeding happens during render, so no
 * render sees a stale value.
 */
export function useSeededValue<T>(seed: T): { value: T; setValue: (next: T) => void; dirty: boolean } {
  const [value, setValue] = useState<T>(seed);
  const [baseline, setBaseline] = useState<T>(seed);
  let current = value;
  let base = baseline;
  if (!same(seed, baseline)) {
    setBaseline(seed);
    base = seed;
    if (same(value, baseline)) {
      setValue(seed);
      current = seed;
    }
  }
  return { value: current, setValue, dirty: !same(current, base) };
}
