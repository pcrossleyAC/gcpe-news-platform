import { apiFetch, ApiError } from "../../api/client";

/**
 * `GET /nrms/api/goto`: the id of the one release a typed reference number, key or id names, or
 * null when it names none (404). Used by the Search screen's box and by "Find a release" in the
 * side menu, so both open a release the same way before falling back to Search results.
 */
export async function gotoReleaseId(typed: string): Promise<string | null> {
  const hit = await apiFetch<{ id: string }>(`/nrms/api/goto?q=${encodeURIComponent(typed)}`).catch((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  });
  return hit ? hit.id : null;
}
