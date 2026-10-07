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
}

const IMMEDIATE: SaveQueue = { run: (task) => task(null) };

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

  const noteVersion = useCallback((v: number) => {
    version.current = version.current === null ? v : Math.max(version.current, v);
  }, []);
  const reset = useCallback(() => {
    version.current = null;
  }, []);

  const queue = useMemo<SaveQueue>(
    () => ({
      run<T>(task: (version: number | null) => Promise<T>): Promise<T> {
        // The version is noted in this chain, before `tail` settles — so the next task, which
        // only starts once `tail` has, always reads it.
        const result = tail.current
          .then(() => task(version.current))
          .then((value) => {
            const next = versionOf(value);
            if (next !== null) noteVersion(next);
            return value;
          });
        tail.current = result.catch(() => undefined);
        return result;
      },
    }),
    [noteVersion],
  );

  return useMemo(() => ({ queue, noteVersion, reset }), [queue, noteVersion, reset]);
}
