import { createContext, useCallback, useContext, useMemo, useRef } from "react";

/**
 * Runs the release editor's section saves one at a time. Every save carries the release's
 * `version` (optimistic concurrency) and every successful save bumps it, so two saves in flight
 * at once would send the same version and the second would 409 against our own first save.
 *
 * `run(task)` starts `task` only once every task queued before it has settled (succeeded or
 * failed — a failure never stalls the queue), and hands it the latest version the page knows
 * about *at that moment*, not when the save was requested. A task's result that carries a
 * `version` (a {@link ReleaseView}) becomes the version the next task gets; a failed task leaves
 * it where it was. A 409 from a queued save is therefore always a genuine conflict — the release
 * moved on the server for some reason other than this page's own saves.
 *
 * `version` is null outside a {@link SaveQueueContext} provider (a section rendered on its own,
 * e.g. in its own tests): tasks then run immediately and keep whatever version they were built
 * with.
 */
export interface SaveQueue {
  run<T>(task: (version: number | null) => Promise<T>): Promise<T>;
  /** Whether the release went from version `from` to `to` through this page's own saves alone
   * (each one sent at the version the one before returned) — so whatever changed on the server
   * in between was this page's doing, not someone else's (useSeededForm). */
  isOwnChange(from: number, to: number): boolean;
}

const IMMEDIATE: SaveQueue = { run: (task) => task(null), isOwnChange: () => false };

export const SaveQueueContext = createContext<SaveQueue>(IMMEDIATE);

export function useSaveQueue(): SaveQueue {
  return useContext(SaveQueueContext);
}

/** `body` with its `version` replaced by the queue's, when the queue has one and `body` is a
 * plain object that carries a version at all. */
export function withVersion(body: unknown, version: number | null): unknown {
  if (version === null || body === null || typeof body !== "object" || Array.isArray(body) || !("version" in body)) return body;
  return { ...body, version };
}

function versionOf(result: unknown): number | null {
  if (result === null || typeof result !== "object" || !("version" in result)) return null;
  const { version } = result as { version: unknown };
  return typeof version === "number" ? version : null;
}

export interface SaveQueueController {
  queue: SaveQueue;
  /** Records a version the page has just seen (initial load, background refresh, Reload).
   * Never moves it backwards: a refresh that was already in flight when one of our own saves
   * landed must not hand the next save the version from before that save. */
  noteVersion(version: number): void;
  /** Forgets the known version — the page is about to load a different release. */
  reset(): void;
}

/** The page-side owner of the queue: one promise chain plus the latest known version. */
export function useSaveQueueController(): SaveQueueController {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const version = useRef<number | null>(null);
  // Each own save that succeeded: the version it was sent at -> the version it returned.
  const ownSteps = useRef(new Map<number, number>());

  const noteVersion = useCallback((v: number) => {
    version.current = version.current === null ? v : Math.max(version.current, v);
  }, []);
  const reset = useCallback(() => {
    version.current = null;
    ownSteps.current.clear();
  }, []);

  const queue = useMemo<SaveQueue>(
    () => ({
      run<T>(task: (version: number | null) => Promise<T>): Promise<T> {
        // The version is noted in this chain, before `tail` settles — so the next task, which
        // only starts once `tail` has, always reads it.
        let sent: number | null = null;
        const result = tail.current
          .then(() => {
            sent = version.current;
            return task(sent);
          })
          .then((value) => {
            const next = versionOf(value);
            if (next !== null) {
              if (sent !== null && next !== sent) ownSteps.current.set(sent, next);
              noteVersion(next);
            }
            return value;
          });
        tail.current = result.catch(() => undefined);
        return result;
      },
      isOwnChange(from: number, to: number): boolean {
        let at = from;
        for (let i = 0; i < 1000 && at !== to; i++) {
          const next = ownSteps.current.get(at);
          if (next === undefined) return false;
          at = next;
        }
        return at === to;
      },
    }),
    [noteVersion],
  );

  return useMemo(() => ({ queue, noteVersion, reset }), [queue, noteVersion, reset]);
}
