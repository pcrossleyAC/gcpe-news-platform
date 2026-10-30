import { createHash } from "node:crypto";
import type { MinistryDto } from "./dto";
import { categoryPageId } from "./site-paths";

/** One entry of the header's ministries menu. */
export interface MenuMinistry {
  key: string;
  name: string;
}

const PREMIER = "Office of the Premier";

/** Legacy names the Premier's office first wherever it lists ministries (CategoryController, _Layout). */
export const isPremier = (name: string): boolean => name === PREMIER;

/**
 * The ministries the legacy `_Layout` and `DefaultController` list: active, top-level (no parent)
 * and with a key that can be a page path. Office of the Premier first, then by name.
 */
export const NO_MINISTRIES = "News API returned no ministries (empty answer); treating the menu as unavailable";

export function ministryMenu(ministries: MinistryDto[]): MenuMinistry[] {
  return ministries
    .filter((m) => m.isActive && !m.parentMinistryKey && categoryPageId("ministries", m.key) !== null)
    .map((m) => ({ key: m.key, name: m.name }))
    .sort((a, b) => Number(b.name === PREMIER) - Number(a.name === PREMIER) || a.name.localeCompare(b.name, "en") || a.key.localeCompare(b.key, "en"));
}

/** What the render-state marker records for the menu; `null` (unavailable) hashes to "". */
export function ministryMenuHash(menu: MenuMinistry[] | null): string {
  return menu === null ? "" : createHash("sha256").update(JSON.stringify(menu)).digest("hex");
}
