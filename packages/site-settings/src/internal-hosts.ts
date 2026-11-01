/**
 * Suite fix W2 (M3, owner approved 2026-10-31): the host names the Hub is reached on that the
 * public can't open (the app server's internal names and aliases). An address stored on one of
 * them works for staff and is broken for the public. Shared by NRMS (the Hub address check) and
 * the Hub (the warnings under URL fields), so both agree on what counts.
 */

/** A URL's host name as compared here: lowercased, one trailing dot dropped (`hub.example.` is `hub.example`). */
export function normalHostName(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * Parses an address as a browser would: absolute (`https://…`) or protocol-relative (`//host/…`,
 * which the page opens over https); null for anything else, a relative path included.
 */
export function parseAddress(address: string): URL | null {
  const text = address.trim();
  if (!/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(text)) return null;
  try {
    return new URL(text, "https://relative.invalid");
  } catch {
    return null;
  }
}

/**
 * The host name (no port) of a bare name, `name:port` or a full address; "" for anything else.
 * A wildcard (`*.gov.bc.ca`) isn't supported, and an IPv6 address needs its brackets (`[fe80::1]`).
 */
export function hostNameOf(entry: string): string {
  const text = entry.trim();
  if (text === "" || /[\s*]/.test(text) || text.startsWith("/")) return "";
  try {
    return normalHostName(new URL(text.includes("://") ? text : `https://${text}`).hostname);
  } catch {
    return "";
  }
}

/** The entries of a configured host list that aren't a host name (and so are ignored), as written. */
export function invalidHostEntries(entries: readonly string[]): string[] {
  return entries.filter((e) => e.trim() !== "" && hostNameOf(e) === "");
}

/** `candidates`' host names, each once, without the public site's own hosts (`publicUrls`): an address there works for the public. */
export function internalHostNames(candidates: readonly string[], publicUrls: readonly string[]): string[] {
  const publicHosts = new Set(publicUrls.map(hostNameOf).filter(Boolean));
  const hosts = candidates.map(hostNameOf).filter((h) => h !== "" && !publicHosts.has(h));
  return [...new Set(hosts)];
}

/**
 * Every distinct address in `text` (plain text or HTML) whose host is one of `hosts`, as written:
 * http(s) addresses, and protocol-relative ones (`//host/…`) where they start an attribute value,
 * a word or the text, not a doubled slash inside a path.
 */
export function internalAddressesIn(text: string, hosts: readonly string[]): string[] {
  if (hosts.length === 0 || !text) return [];
  const wanted = new Set(hosts);
  const found: string[] = [];
  for (const [address] of text.matchAll(/(?:\bhttps?:|(?<![\w:/.%-]))\/\/[^\s"'<>()]+/gi)) {
    const trimmed = address.replace(/[.,;:!?]+$/, "");
    const url = parseAddress(trimmed);
    if (url && wanted.has(normalHostName(url.hostname)) && !found.includes(trimmed)) found.push(trimmed);
  }
  return found;
}
