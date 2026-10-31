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

/** `GET /nrms/api/config`'s public origin for files ({@link publicFilesOrigin}); "" until it answers, or if it fails. */
export function usePublicFilesOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setOrigin(publicFilesOrigin(config));
      },
      () => {
        // Keep "": addresses fall back to the page's origin, and no warning is shown.
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return origin;
}
