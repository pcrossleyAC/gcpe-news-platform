import { useEffect, useState } from "react";
import { apiFetch } from "../../../api/client";

interface ConfigResponse {
  publicSiteUrl: string;
}

/** `GET /nrms/api/config`'s `publicSiteUrl` (Task 1) — the base URL "View on site" (ViewLinks.tsx)
 * builds a release's public link from. Mirrors format/tenantTimeZone.ts's own
 * `useTenantTimeZone` (its own small per-hook fetch, not a shared cache) rather than adding a
 * new shared config hook outside this task's file scope. */
export function usePublicSiteUrl(): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setUrl(config.publicSiteUrl);
      },
      () => {
        // No link shown until it resolves — see ViewLinks.tsx.
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return url;
}
