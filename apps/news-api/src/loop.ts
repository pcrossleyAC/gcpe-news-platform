import { safeErrorLabel } from "@gcpe/http-kit";

/** Runs `fn` every `intervalMs`, never two at once; a failure is logged as the label and a safe label. */
export function every(intervalMs: number, label: string, fn: () => Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    fn()
      .catch((e) => console.error(`[news-api] ${label} failed ${safeErrorLabel(e)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
