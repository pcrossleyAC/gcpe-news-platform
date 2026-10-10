import { ApiError } from "../../api/client";

/** 400 `issues` (zod) are a different shape from the NRMS section's 422 `problems` — this reads
 * either an ApiError's `issues` (mapping each `ZodIssue`'s `message`) or its own plain
 * `message`, so every write on this screen shows something useful regardless of which shape
 * the server sent. */
export function messagesOf(caught: unknown): string[] {
  if (caught instanceof ApiError) {
    if (caught.issues?.length) return caught.issues.map((i) => (i as { message?: string }).message ?? "Invalid request.");
    return [caught.message];
  }
  return ["Something went wrong."];
}
