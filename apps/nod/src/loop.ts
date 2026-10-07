import { safeErrorLabel } from "@gcpe/http-kit";

/**
 * Calls `run` every `intervalMs`, never two at once. A failure is logged by label and never
 * stops later calls. The returned stop function clears the interval and waits for a call in
 * flight. Gating (every 5 minutes, nightly) lives in `run` itself, so a minute's interval is
 * enough for every worker.
 */
export function startLoop(label: string, run: () => Promise<unknown>, intervalMs = 60_000): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = run()
      .catch((e) => console.error(`[nod] ${label} failed: ${safeErrorLabel(e)}`))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
