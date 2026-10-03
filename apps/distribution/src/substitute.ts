const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function substitute(template: string, values: Record<string, string>, mode: "html" | "text" | "header"): string {
  // One pass over the template: replacement text is never rescanned, so values can't inject placeholders.
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) return whole;
    const v = values[name]!;
    return mode === "html" ? escapeHtml(v) : mode === "header" ? v.replace(/[\r\n\0]/g, "") : v;
  });
}
