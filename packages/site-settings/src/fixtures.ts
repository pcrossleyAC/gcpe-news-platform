import { readFileSync } from "node:fs";
import type { SiteSettings } from "./model";

/** Test-only: the bc tenant's settings file. */
export function bcSettings(): SiteSettings {
  return JSON.parse(readFileSync(new URL("../../../config/tenants/bc.site-settings.json", import.meta.url), "utf8")) as SiteSettings;
}
