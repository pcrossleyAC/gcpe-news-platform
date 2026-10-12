const DEFAULT_SCHEMES = ["http:", "https:"] as const;

export interface SafeUrlOptions {
  /** Also allow `mailto:` (default `false`). */
  mailto?: boolean;
  /** Allow a single-slash site-relative path, e.g. `/files/a.png` (default `true`). */
  relative?: boolean;
  /** Override the allowed absolute-URL schemes entirely — ignores `mailto` when given. Default
   * is `["http:", "https:"]`, plus `"mailto:"` when `mailto` is true. */
  schemes?: readonly string[];
}

/**
 * Whether `u` is safe to write into an `href`/`src` attribute: an absolute `http:`/`https:` URL
 * (and, when asked, `mailto:`, or a caller-supplied scheme list), or a single-slash
 * site-relative path. Used wherever a URL comes from data the platform doesn't fully trust — a
 * tenant's theme config, a News API field — before it's HTML-escaped and written out. Escaping
 * alone only neutralises HTML metacharacters; it does nothing to stop a `javascript:`/
 * `vbscript:`/`data:` URL from running as a link or image load (stored XSS), or a
 * protocol-relative `//host` URL from silently leaving the site.
 *
 * Refuses a backslash, any whitespace, or a C0/DEL control character *anywhere* in the raw
 * string, checked before any parsing or relative-path logic. This isn't just about hiding a
 * scheme behind a tab (`"java\tscript:"`) — a leading `/\host` is the one that matters most:
 * browsers (and Node's own `URL`, the same WHATWG algorithm) treat `\` the same as `/` when
 * resolving a relative reference against a "special" scheme like http/https, so
 * `"/\\evil.example"` resolves to `//evil.example` — a different origin — even though it
 * "starts with / and not //" under a check that only looks at the first two characters. Refusing
 * any backslash outright closes that regardless of position.
 */
export function isSafeUrl(u: string | null | undefined, opts: SafeUrlOptions = {}): boolean {
  if (!u) return false;
  // eslint-disable-next-line no-control-regex -- the control-character range is the point.
  if (/[\\\s\u0000-\u001F\u007F]/.test(u)) return false;

  const relative = opts.relative ?? true;
  if (u.startsWith("/")) {
    // A backslash anywhere was already refused above, so "second character isn't / or \" only
    // has to rule out the double-slash (protocol-relative) form here.
    return relative && u[1] !== "/";
  }

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  const schemes = opts.schemes ?? (opts.mailto ? [...DEFAULT_SCHEMES, "mailto:"] : DEFAULT_SCHEMES);
  return schemes.includes(parsed.protocol.toLowerCase());
}
