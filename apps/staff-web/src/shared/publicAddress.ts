import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

/**
 * W1 (suite review, owner approved 2026-10-31): the public site's addresses for Website files.
 *
 * Staff reach the Hub on its own host, which in production is the internal app server that the
 * public can't reach (docs/deploy/windows.md). A `/files/<name>` link copied from the Hub would
 * carry that host, so the public would get a broken image or link while staff see it working.
 * Every address the Hub offers to copy is built on the configured public base instead, and an
 * address pasted into a URL field that points at the Hub's own host gets a warning.
 */

interface ConfigResponse {
  /** NRMS's PUBLIC_FILES_BASE: the public origin `/files/…` is served from (what published releases use). */
  filesBase?: string;
  /** The public site's base URL. */
  publicSiteUrl?: string;
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
 * The warning for an address on the Hub's own host (`hubHost`, the page's `location.host`) when
 * the public site lives elsewhere; null for any other address, a blank or unparseable one, when
 * the Hub and the public site share a host (a test site such as boxs.ca), where it works, or while
 * the public origin isn't known.
 */
export function staffHostWarning(url: string, publicOrigin: string, hubHost: string = window.location.host): string | null {
  let host: string;
  try {
    host = new URL(url.trim()).host;
  } catch {
    return null;
  }
  if (host === "" || host !== hubHost) return null;
  const publicHost = originOf(publicOrigin) ? new URL(publicOrigin).host : "";
  return publicHost === "" || publicHost === hubHost ? null : STAFF_HOST_WARNING;
}

/**
 * Fix round 1 (I4), for addresses typed into a prompt (the rich-text Link and Insert asset): a
 * `/files/…` address on the Hub's own host is unambiguous, so it becomes the same file's public
 * address; any other Hub address keeps its text and carries {@link STAFF_HOST_WARNING} for the
 * caller to ask about. Everything else passes through with no warning.
 */
export function checkHubAddress(url: string, publicOrigin: string, hubHost: string = window.location.host): { url: string; warning: string | null } {
  const warning = staffHostWarning(url, publicOrigin, hubHost);
  if (!warning) return { url, warning: null };
  const parsed = new URL(url.trim());
  if (parsed.pathname.startsWith("/files/")) return { url: new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin).href, warning: null };
  return { url, warning };
}

/** One `GET /nrms/api/config` for the public origin ({@link publicFilesOrigin}); "" if it fails. For
 * code that only needs it at the moment of use (the rich-text prompts), not on every mount. */
export function fetchPublicFilesOrigin(): Promise<string> {
  return apiFetch<ConfigResponse>("/nrms/api/config").then(publicFilesOrigin, () => "");
}

export interface PublicFiles {
  /** "loading" until `GET /nrms/api/config` answers; "failed" if it didn't. */
  status: "loading" | "ready" | "failed";
  /** The configured public origin ({@link publicFilesOrigin}); "" when not (yet) known or not configured. */
  origin: string;
}

/**
 * `GET /nrms/api/config`'s public origin for files. Fix round 1 (I3): a screen that offers an
 * address to copy waits for "ready", so it never offers the Hub's own address as the public one
 * while the answer is pending or after it failed; only a ready answer with no public base
 * configured (a development stack) falls back to the page's origin, in {@link publicFileUrl}.
 */
export function usePublicFiles(): PublicFiles {
  const [state, setState] = useState<PublicFiles>({ status: "loading", origin: "" });
  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setState({ status: "ready", origin: publicFilesOrigin(config) });
      },
      () => {
        if (active) setState({ status: "failed", origin: "" });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/** {@link usePublicFiles}'s origin alone, for the Hub-address warnings (none while it is unknown). */
export function usePublicFilesOrigin(): string {
  return usePublicFiles().origin;
}
