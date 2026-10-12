import type { SiteTheme } from "@gcpe/config";

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
/** The fallback stack: family names, quotes, commas, spaces and hyphens only. */
const cssStack = (s: string) => s.replace(/[^A-Za-z0-9 ,"'-]/g, "");

/** spec §6.3: theme.css from site.theme, as CSS variables; every rule below uses only them. */
export function themeCss(theme: SiteTheme): string {
  const vars = Object.entries(theme.colors)
    .map(([name, value]) => `  --color-${kebab(name)}: ${value};`)
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
main { max-width: 70rem; margin: 0 auto; padding: 1rem; }
main:focus { outline: none; }
.muted, time { color: var(--color-muted-text); }
.card { background: var(--color-surface); border: 1px solid var(--color-border); padding: 1rem; margin: 0 0 1rem; }
.post-list { list-style: none; padding: 0; }
.post-list li { border-bottom: 1px solid var(--color-border); padding: 0.75rem 0; }
.site-footer { border-top: 4px solid var(--color-accent); background: var(--color-surface); padding: 1rem; }
.site-footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
figure { margin: 1rem 0; }
img { max-width: 100%; height: auto; }
`;
}
