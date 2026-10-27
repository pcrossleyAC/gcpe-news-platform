// Shared by scripts/windows-env.ts and scripts/windows-db-setup.ts. Kept apart from both: each is
// bundled as its own tool, and importing one from the other would pull in its entry-point guard.

/** JSON.parse whose error never quotes the input: it carries passwords. */
export function parseJsonQuietly(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the input on stdin is not valid JSON");
  }
}
