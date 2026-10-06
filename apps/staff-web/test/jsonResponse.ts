/** Shared `fetch` response builder for apps/staff-web tests (Task 4 fix round 1, minor: a
 * single copy for the new test files, instead of each redefining it). Deliberately not
 * retrofitted onto Task 1–3 test files — this only touches files this task owns. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
