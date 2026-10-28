import { readFileSync } from "node:fs";
import type { SiteSettings, StoredSiteSettings } from "./model";

/** Test-only: the bc tenant's settings file. */
export function bcSettings(): SiteSettings {
  return JSON.parse(readFileSync(new URL("../../../config/tenants/bc.site-settings.json", import.meta.url), "utf8")) as SiteSettings;
}

/** Test-only: the bc settings as a document published before parity plan 4 — no `contactsPage`,
 * `pageText` or `navigation`, and no `connect.linkedin`, `policyLink` or `intro`. */
export function prePlan4Settings(): StoredSiteSettings {
  const d: StoredSiteSettings = bcSettings();
  delete d.contactsPage;
  delete d.pageText;
  delete d.navigation;
  delete d.connect.linkedin;
  delete d.connect.policyLink;
  delete d.connect.intro;
  delete d.theme.colors.sectionBar;
  return d;
}
