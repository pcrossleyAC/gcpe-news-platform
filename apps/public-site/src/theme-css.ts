import type { SiteTheme } from "@gcpe/config";
import type { ThemeColors } from "@gcpe/site-settings";

/** Used when no tenant config loaded (TENANT_CONFIG unset and the default missing). Neutral,
 * and passes the same contrast check the tenant loader applies. */
export const DEFAULT_THEME: SiteTheme = {
  colors: {
    primary: "#1F3A5F",
    primaryText: "#FFFFFF",
    accent: "#C77700",
    text: "#1A1A1A",
    mutedText: "#4D4D4D",
    surface: "#F4F4F4",
    background: "#FFFFFF",
    border: "#CCCCCC",
  },
  font: { family: "Noto Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Home" },
  footerLinks: [],
};

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** A CSS string literal: quotes, backslashes and anything that could end the rule or start a
 * new declaration (including a bare colon) are dropped. */
const cssString = (s: string) => `"${s.replace(/["\\;:{}<>\n\r]/g, "")}"`;
/** The fallback stack: letters, digits, spaces, commas and hyphens only — no quotes. Unlike
 * `cssString`'s family value, this text is spliced in unquoted; a stray quote left in would
 * open an unterminated string that drops the whole --font-family declaration. A multi-word
 * family name needs no quotes here either way: CSS reads consecutive identifiers in a
 * font-family value as one name joined by spaces. */
const cssStack = (s: string) => s.replace(/[^A-Za-z0-9 ,-]/g, "");

/** The site settings' default banner colours (spec "Defaults"). */
const DEFAULT_BANNER_COLORS = { bannerInfo: "#013366", bannerEmergency: "#D8292F", sectionBar: "#2B5580" };
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** P7: the legacy stylesheets' variables, pointed at our tokens, so an admin colour edit only changes theme.css. */
const LEGACY_ALIASES =
  ":root{--primary-blue:var(--color-primary);--info-blue:var(--color-primary);--theme-text:var(--color-text);--theme-link:var(--color-primary);--theme-footer-background:var(--color-background)}";

/**
 * spec §6.3: theme.css from site.theme, as CSS variables, plus the legacy variable aliases. Every
 * other rule lives in assets/site/overrides.css, which loads before this file; the :focus-visible
 * rule stays last so it wins over all legacy CSS (P6). The site settings' `theme.colors` (when
 * given) replace the tenant's colours and add the banner and section-bar colours. A colour that isn't
 * `#RRGGBB` (a document that bypassed validation) never reaches the stylesheet: the tenant's (or
 * default banner) colour stands in for it.
 */
export function themeCss(theme: SiteTheme, colors?: ThemeColors): string {
  const fallback: Record<string, string> = { ...theme.colors, ...DEFAULT_BANNER_COLORS };
  const vars = Object.entries(fallback)
    .map(([name, value]) => {
      const chosen = (colors as Record<string, string> | undefined)?.[name];
      return `  --color-${kebab(name)}: ${chosen && HEX.test(chosen) ? chosen : value};`;
    })
    .join("\n");
  return `:root {
${vars}
  --font-family: ${cssString(theme.font.family)}, ${cssStack(theme.font.fallback)};
}
${LEGACY_ALIASES}
:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; }
`;
}
