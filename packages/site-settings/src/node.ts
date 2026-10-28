import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultSiteSettings } from "./defaults";
import type { SiteSettings } from "./model";

/**
 * Node-only (reads the file system, so it is not part of the browser-safe main entry).
 *
 * What the site shows before anything is published: `<tenantId>.site-settings.json` beside the
 * tenant config when it exists (validated by `defaultSiteSettings`, which throws on an invalid
 * document), else defaults derived from the tenant theme. The tenant id is the config's own
 * `tenantId` field (the tenant loader requires it), falling back to the config's file name.
 */
export function loadSiteSettingsDefaults(
  tenantConfigPath: string,
  tenantTheme: Parameters<typeof defaultSiteSettings>[0],
): SiteSettings {
  const config = JSON.parse(readFileSync(tenantConfigPath, "utf8")) as { tenantId?: unknown };
  const tenantId = typeof config.tenantId === "string" && config.tenantId ? config.tenantId : basename(tenantConfigPath, ".json");
  const file = join(dirname(tenantConfigPath), `${tenantId}.site-settings.json`);
  return existsSync(file) ? defaultSiteSettings(tenantTheme, JSON.parse(readFileSync(file, "utf8"))) : defaultSiteSettings(tenantTheme);
}
