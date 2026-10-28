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

/** A 400's zod issues as `{field, message}`, the field path written like site settings' —
 * `["topicLinks", 1, "url"]` ⇒ `topicLinks[1].url`, `["social", "flickrUrl"]` ⇒ `social.flickrUrl`
 * — so a form can put each message beside its field. Empty for anything else. */
export function fieldErrorsOf(caught: unknown): { field: string; message: string }[] {
  if (!(caught instanceof ApiError) || !caught.issues?.length) return [];
  return caught.issues.map((issue) => {
    const { path = [], message = "Invalid request." } = issue as { path?: (string | number)[]; message?: string };
    const field = path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
    return { field, message };
  });
}

/** The alert a form shows when it has put the server's messages beside their fields. */
export const FIX_BELOW = "Fix the problems shown below, then save.";
