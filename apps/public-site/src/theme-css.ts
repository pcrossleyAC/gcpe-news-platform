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
const DEFAULT_BANNER_COLORS = { bannerInfo: "#013366", bannerEmergency: "#D8292F" };
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * spec §6.3: theme.css from site.theme, as CSS variables; every rule below uses only them. The
 * site settings' `theme.colors` (when given) replace the tenant's colours and add the two banner
 * colours. A colour that isn't `#RRGGBB` (a document that bypassed validation) never reaches the
 * stylesheet: the tenant's (or default banner) colour stands in for it.
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
*, *::before, *::after { box-sizing: border-box; }
html { font-family: var(--font-family); color: var(--color-text); background: var(--color-background); line-height: 1.5; }
body { margin: 0; }
a { color: var(--color-primary); }
:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; }
.skip-link { position: absolute; left: -9999px; top: 0; background: var(--color-primary); color: var(--color-primary-text); padding: 0.5rem 1rem; z-index: 10; }
.skip-link:focus { left: 0.5rem; }
.site-header { background: var(--color-primary); color: var(--color-primary-text); padding: 0.75rem 1rem; display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; }
.site-header a { color: var(--color-primary-text); }
.site-header .brand { display: inline-flex; gap: 0.75rem; align-items: center; text-decoration: none; font-weight: 700; }
.site-header .logo { height: 3rem; width: auto; }
.site-header nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.blue-bridge-banner { background: var(--color-text); color: var(--color-background); padding: 0.75rem 1rem; font-weight: 700; }
.site-banner { background: var(--color-banner-info); color: white; padding: 0.75rem 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; }
.site-banner-emergency { background: var(--color-banner-emergency); }
.site-banner p, .site-banner ul { margin: 0; }
.site-banner ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.site-banner a { color: inherit; font-weight: 700; }
.site-banner button { margin-left: auto; background: transparent; color: inherit; border: 2px solid currentColor; padding: 0.25rem 0.75rem; font: inherit; cursor: pointer; }
.site-banner :focus-visible { outline-color: white; }
main { max-width: 70rem; margin: 0 auto; padding: 1rem; }
main:focus { outline: none; }
.muted, time { color: var(--color-muted-text); }
.card { background: var(--color-surface); border: 1px solid var(--color-border); padding: 1rem; margin: 0 0 1rem; }
.post-list { list-style: none; padding: 0; }
.post-list li { border-bottom: 1px solid var(--color-border); padding: 0.75rem 0; }
.site-footer { border-top: 4px solid var(--color-accent); background: var(--color-surface); padding: 1rem; }
.site-footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.site-footer h2 { font-size: 1.125rem; margin: 1rem 0 0.5rem; }
.site-footer .footer-columns { display: flex; flex-wrap: wrap; gap: 0 3rem; }
.site-footer .copyright { margin: 1rem 0 0; color: var(--color-muted-text); }
.connect-list { list-style: none; padding: 0; }
.connect-list li { border-bottom: 1px solid var(--color-border); padding: 0.5rem 0; }
.connect-list p { margin: 0.25rem 0 0; color: var(--color-muted-text); }
.ministry-layout { display: grid; gap: 1rem; }
.ministry-layout aside h2 { font-size: 1.125rem; }
@media (min-width: 48rem) {
  .ministry-layout { grid-template-columns: 18rem minmax(0, 1fr); gap: 2rem; align-items: start; }
}
figure { margin: 1rem 0; }
img { max-width: 100%; height: auto; }
`;
}
