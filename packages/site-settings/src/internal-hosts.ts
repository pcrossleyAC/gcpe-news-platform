/**
 * Suite fix W2 (M3, owner approved 2026-10-31): the host names the Hub is reached on that the
 * public can't open (the app server's internal names and aliases). An address stored on one of
 * them works for staff and is broken for the public. Shared by NRMS (the Hub address check) and
 * the Hub (the warnings under URL fields), so both agree on what counts.
 */

/** The lowercased host name (no port) of a bare name, `name:port` or a full address; "" for anything else. */
export function hostNameOf(entry: string): string {
  const text = entry.trim();
  if (text === "" || /\s/.test(text) || text.startsWith("/")) return "";
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** `candidates`' host names, each once, without the public site's own hosts (`publicUrls`): an address there works for the public. */
export function internalHostNames(candidates: readonly string[], publicUrls: readonly string[]): string[] {
  const publicHosts = new Set(publicUrls.map(hostNameOf).filter(Boolean));
  const hosts = candidates.map(hostNameOf).filter((h) => h !== "" && !publicHosts.has(h));
  return [...new Set(hosts)];
}

/** Every distinct http(s) address in `text` (plain text or HTML) whose host is one of `hosts`, as written. */
export function internalAddressesIn(text: string, hosts: readonly string[]): string[] {
  if (hosts.length === 0 || !text) return [];
  const wanted = new Set(hosts);
  const found: string[] = [];
  for (const [address] of text.matchAll(/\bhttps?:\/\/[^\s"'<>()]+/gi)) {
    const trimmed = address.replace(/[.,;:!?]+$/, "");
    let host: string;
    try {
      host = new URL(trimmed).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (wanted.has(host) && !found.includes(trimmed)) found.push(trimmed);
  }
  return found;
}
