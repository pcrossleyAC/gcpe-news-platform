import type { ZodError } from "zod";

/** One-line summary of a Zod failure: `path.to.field: message; other: message`. */
export function formatIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
