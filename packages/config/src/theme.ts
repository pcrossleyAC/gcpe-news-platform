import { z } from "zod";

/** WCAG 2.2 AA minimum contrast for normal-size text (success criterion 1.4.3). */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio of two #RRGGBB colours, from 1 to 21. The order doesn't matter. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (name: string) => z.string().regex(/^#[0-9a-fA-F]{6}$/, `${name} must be #RRGGBB`);

const colorsSchema = z.object({
  primary: hex("primary"),
  primaryText: hex("primaryText"),
  accent: hex("accent"),
  text: hex("text"),
  mutedText: hex("mutedText"),
  surface: hex("surface"),
  background: hex("background"),
  border: hex("border"),
});

/** The pairs spec §3 checks: foreground first. */
const CHECKED_PAIRS = [
  ["text", "background"],
  ["text", "surface"],
  ["primaryText", "primary"],
] as const;

// Relative, no leading slash, no "..", no URL scheme: the file lives in the site's own assets.
const ASSET_PATH = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export const siteThemeSchema = z
  .object({
    colors: colorsSchema,
    font: z.object({
      family: z.string().min(1),
      fallback: z.string().min(1),
      stylesheetUrl: z.string().url().optional(),
    }),
    logo: z.object({
      path: z.string().regex(ASSET_PATH, "logo.path must be a relative path under the site's assets"),
      alt: z.string().min(1),
    }),
    footerLinks: z.array(z.object({ label: z.string().min(1), url: z.string().url() })),
  })
  .superRefine((theme, ctx) => {
    for (const [fg, bg] of CHECKED_PAIRS) {
      const ratio = contrastRatio(theme.colors[fg], theme.colors[bg]);
      if (ratio < WCAG_AA_TEXT_CONTRAST) {
        // Floored, so a failing 4.499 never prints as a passing-looking "4.50".
        const shown = (Math.floor(ratio * 100) / 100).toFixed(2);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["colors", fg],
          message: `${fg} ${theme.colors[fg]} on ${bg} ${theme.colors[bg]} has contrast ${shown}:1, below WCAG AA ${WCAG_AA_TEXT_CONTRAST}:1`,
        });
      }
    }
  });

export type SiteTheme = z.infer<typeof siteThemeSchema>;
