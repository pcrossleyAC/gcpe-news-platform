import type pg from "pg";
import { extractFileReferences, mergeExtracted, type Extracted } from "./references";

/**
 * Where legacy `/files/` links can be in our content, by the stack's database setting. Every
 * text and JSON column of these tables is searched (each row as JSON, so a column added later
 * is covered too); a table this database doesn't have is skipped.
 *
 * - NEWSAPI: the published projection: posts (bodies, summaries, translation and asset lists —
 *   legacy-imported and NRMS-published), categories (ministry details, the minister's bio),
 *   the carousel, home, site settings, resource links.
 * - NRMS: every release in every status (bodies of drafts and scheduled releases, so a release
 *   published after the run is covered by the catch-up run anyway), site settings and their
 *   drafts and revisions, carousels and slides, emergency pins, page images, resource links.
 * - CORE: organizations (the minister's bio as staff edit it).
 */
export const SCAN_TABLES = {
  NEWSAPI: ["posts", "categories", "slides", "home", "site_settings", "resource_links"],
  NRMS: [
    "news_releases",
    "release_documents",
    "document_languages",
    "site_settings",
    "site_settings_drafts",
    "site_settings_revisions",
    "carousels",
    "slides",
    "public_import_carousel",
    "public_import_slides",
    "emergency_pins",
    "page_images",
    "page_image_languages",
    "resource_links",
  ],
  CORE: ["organizations"],
} as const;

export type ScanSource = keyof typeof SCAN_TABLES;

/** Derived columns (the News API's lowercased search text and its vector): copies of other columns, so not scanned. */
const DERIVED_COLUMNS = new Set(["search_text", "search_vector", "embedding_text_hash"]);

/** Every string inside a parsed JSON value. */
function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

/**
 * A `--scan-file`: JSON (an API response, an export) has every string searched, so HTML inside
 * JSON keeps its quoted attributes; anything else (HTML, an IIS log) is searched as text.
 */
export function extractFromFileText(text: string): Extracted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return extractFileReferences(text);
  }
  const parts: Extracted[] = [];
  for (const s of strings(parsed)) if (/\/files\//i.test(s)) parts.push(extractFileReferences(s));
  return mergeExtracted(parts);
}

export interface ScanResult {
  extracted: Extracted;
  /** Rows that mention /files/, by table. */
  rows: Record<string, number>;
}

/** Legacy /files/ links in `tables` (public schema) of the database behind `pool`. Read-only. */
export async function scanDatabase(pool: pg.Pool, tables: readonly string[]): Promise<ScanResult> {
  const parts: Extracted[] = [];
  const rows: Record<string, number> = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name ${table}`);
    const { rows: exists } = await pool.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [`public.${table}`]);
    if (!exists[0]?.t) continue;
    const res = await pool.query<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM public."${table}" t WHERE row_to_json(t)::text ILIKE '%/files/%'`);
    rows[table] = res.rows.length;
    for (const r of res.rows) {
      const row = JSON.parse(r.j) as Record<string, unknown>;
      for (const k of DERIVED_COLUMNS) delete row[k];
      for (const s of strings(row)) if (/\/files\//i.test(s)) parts.push(extractFileReferences(s));
    }
  }
  return { extracted: mergeExtracted(parts), rows };
}
