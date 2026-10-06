import { z } from "zod";

const FLAGS = {
  "--allow-empty-slides": "allowEmptySlides",
  "--no-unpublish-missing": "unpublishMissing",
} as const;

/** Env equivalents of the CLI flags (a flag wins when both are given). */
export const importOptionsEnvSchema = z.object({
  LEGACY_ALLOW_EMPTY_SLIDES: z.enum(["true", "false"]).optional(),
  LEGACY_UNPUBLISH_MISSING: z.enum(["true", "false"]).optional(),
});

export interface ImportCliOptions {
  allowEmptySlides: boolean;
  unpublishMissing: boolean;
}

/**
 * Options for importLegacyNews from the import CLI's argv (after `node script`) and env:
 * - `--allow-empty-slides` / LEGACY_ALLOW_EMPTY_SLIDES=true: an empty current carousel
 *   clears the slides table (default: keep existing slides).
 * - `--no-unpublish-missing` / LEGACY_UNPUBLISH_MISSING=false: don't unpublish posts absent
 *   from legacy's published set.
 * Unknown arguments are rejected rather than silently ignored (a typo'd flag would otherwise
 * run a full import with the default behaviour).
 */
export function parseImportCliOptions(argv: string[], env: z.infer<typeof importOptionsEnvSchema>): ImportCliOptions {
  const options: ImportCliOptions = {
    allowEmptySlides: env.LEGACY_ALLOW_EMPTY_SLIDES === "true",
    unpublishMissing: env.LEGACY_UNPUBLISH_MISSING !== "false",
  };
  for (const arg of argv) {
    if (!Object.hasOwn(FLAGS, arg)) throw new Error(`Unknown argument: ${arg} (supported: ${Object.keys(FLAGS).join(", ")})`);
    const flag = arg as keyof typeof FLAGS;
    if (FLAGS[flag] === "allowEmptySlides") options.allowEmptySlides = true;
    else options.unpublishMissing = false;
  }
  return options;
}
