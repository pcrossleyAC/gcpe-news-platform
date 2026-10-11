const DEFAULT_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 5000;

/** Spec §4: default 1,000 ms, clamped to 200–5,000. Anything unparseable is the default. */
export function clampTimeoutMs(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(n)));
}
