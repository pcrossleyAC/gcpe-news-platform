import { useCallback, useEffect, useState } from "react";
import { hostNameOf, normalHostName, parseAddress } from "@gcpe/site-settings";
import { apiFetch } from "../api/client";

/**
 * W1 (suite review, owner approved 2026-10-31): the public site's addresses for Website files.
 *
 * Staff reach the Hub on its own host, which in production is the internal app server that the
 * public can't reach (docs/deploy/windows.md). A `/files/<name>` link copied from the Hub would
 * carry that host, so the public would get a broken image or link while staff see it working.
 * Every address the Hub offers to copy is built on the configured public base instead, and an
 * address pasted into a URL field that points at the Hub's own host gets a warning.
 *
 * Suite fix W2 (M3): "the Hub's own host" is the page's host plus every internal name the server
 * knows (`GET /nrms/api/config`'s internalHosts: NRMS_INTERNAL_HOSTS and the sign-in host), so an
 * address on another alias of the same server is caught too.
 */

interface ConfigResponse {
  /** NRMS's PUBLIC_FILES_BASE: the public origin `/files/…` is served from (what published releases use). */
  filesBase?: string;
  /** The public site's base URL. */
  publicSiteUrl?: string;
  /** Suite fix W2 (M3): the Hub's other internal host names (never the public site's). */
  internalHosts?: string[];
}

const originOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
};

/** The public origin for `/files/…`: `filesBase`, else the public site URL's origin; "" when neither is configured. */
export function publicFilesOrigin(config: ConfigResponse): string {
  return originOf(config.filesBase) || originOf(config.publicSiteUrl);
}

/**
 * A file's full public address. `path` is the server's `/files/<name>`; with no public origin
 * configured (a local development stack) it falls back to the page's own origin, as before.
 */
export function publicFileUrl(path: string, origin: string, pageOrigin: string = window.location.origin): string {
  return new URL(path, origin || pageOrigin).href;
}

export const STAFF_HOST_WARNING = "This address points at the Hub, which the public can't open. On Website → Files, use Copy public address and paste that instead.";

/**
 * The warning for an address on one of the Hub's hosts (`hubHosts`: the page's `location.host`,
 * plus the server's internal names) when the public site lives elsewhere; null for any other
 * address, a blank or unparseable one, one on the public site's own host (a test site such as
 * boxs.ca shares it with the Hub, and it works there), or while the public origin isn't known.
 * Hosts compare by name, ignoring case and port.
 */
export function staffHostWarning(url: string, publicOrigin: string, hubHosts: string | readonly string[] = window.location.host): string | null {
  // Fix round 1 (N1, N2): `//host/…` counts, as a browser opens it; `host.` is `host`.
  const parsed = parseAddress(url);
  if (!parsed) return null;
  const host = normalHostName(parsed.hostname);
  const publicHost = originOf(publicOrigin) ? normalHostName(new URL(publicOrigin).hostname) : "";
  if (host === "" || publicHost === "" || host === publicHost) return null;
  const hosts = (typeof hubHosts === "string" ? [hubHosts] : hubHosts).map(hostNameOf);
  return hosts.includes(host) ? STAFF_HOST_WARNING : null;
}

/**
 * Fix round 1 (I4), for addresses typed into a prompt (the rich-text Link and Insert asset): a
 * `/files/…` address on the Hub's own host is unambiguous, so it becomes the same file's public
 * address; any other Hub address keeps its text and carries {@link STAFF_HOST_WARNING} for the
 * caller to ask about. Everything else passes through with no warning.
 */
export function checkHubAddress(url: string, publicOrigin: string, hubHosts: string | readonly string[] = window.location.host): { url: string; warning: string | null } {
  const warning = staffHostWarning(url, publicOrigin, hubHosts);
  if (!warning) return { url, warning: null };
  const parsed = parseAddress(url)!;
  if (parsed.pathname.startsWith("/files/")) return { url: new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin).href, warning: null };
  return { url, warning };
}

/** The page's own host and the server's internal names: every host {@link staffHostWarning} treats as the Hub's. */
const hubHostsFrom = (config: ConfigResponse | null): string[] => [window.location.host, ...(config?.internalHosts ?? [])];

/** One `GET /nrms/api/config` for the public origin ({@link publicFilesOrigin}) and the Hub's
 * hosts; origin "" if it fails. For code that only needs them at the moment of use (the
 * rich-text prompts), not on every mount. */
export function fetchHubAddresses(): Promise<{ origin: string; hubHosts: string[] }> {
  return apiFetch<ConfigResponse>("/nrms/api/config").then(
    (config) => ({ origin: publicFilesOrigin(config), hubHosts: hubHostsFrom(config) }),
    () => ({ origin: "", hubHosts: hubHostsFrom(null) }),
  );
}

export interface PublicFiles {
  /** "loading" until `GET /nrms/api/config` answers; "failed" if it didn't. */
  status: "loading" | "ready" | "failed";
  /** The configured public origin ({@link publicFilesOrigin}); "" when not (yet) known or not configured. */
  origin: string;
  /** The page's host and the server's internal host names (W2, M3). */
  hubHosts: string[];
}

/**
 * `GET /nrms/api/config`'s public origin for files. Fix round 1 (I3): a screen that offers an
 * address to copy waits for "ready", so it never offers the Hub's own address as the public one
 * while the answer is pending or after it failed; only a ready answer with no public base
 * configured (a development stack) falls back to the page's origin, in {@link publicFileUrl}.
 */
export function usePublicFiles(): PublicFiles {
  const [state, setState] = useState<PublicFiles>({ status: "loading", origin: "", hubHosts: hubHostsFrom(null) });
  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setState({ status: "ready", origin: publicFilesOrigin(config), hubHosts: hubHostsFrom(config) });
      },
      () => {
        if (active) setState({ status: "failed", origin: "", hubHosts: hubHostsFrom(null) });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/** {@link staffHostWarning} with this deployment's public origin and Hub hosts (no warning while they are unknown). */
export function useStaffHostWarning(): (url: string) => string | null {
  const { origin, hubHosts } = usePublicFiles();
  return useCallback((url: string) => staffHostWarning(url, origin, hubHosts), [origin, hubHosts]);
}
