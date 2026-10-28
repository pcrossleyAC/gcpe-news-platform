/**
 * Legacy-only HTML that news.gov never displayed (dbo.Ministry and dbo.Sector MiscHtml, MiscRightHtml and the
 * Facebook, YouTube and audio embeds; hidden from legacy editors). Owner decision 2026-10-28: carried over, not dropped.
 *
 * Stored as-is in a nullable jsonb column and never rendered, edited, published as an event or sent to a public
 * surface. It is raw, untrusted HTML. Only the legacy importer writes it; no other upsert touches it.
 */
export const LEGACY_EXTRA_COLUMNS = {
  miscHtml: "MiscHtml",
  miscRightHtml: "MiscRightHtml",
  facebookEmbedHtml: "FacebookEmbedHtml",
  youtubeEmbedHtml: "YoutubeEmbedHtml",
  audioEmbedHtml: "AudioEmbedHtml",
} as const;

export type LegacyExtraKey = keyof typeof LEGACY_EXTRA_COLUMNS;
export type LegacyExtras = Partial<Record<LegacyExtraKey, string>>;

/** The non-blank columns of a legacy row, or null when there are none. Values are kept verbatim. */
export function pickLegacyExtras(row: Record<string, unknown>): LegacyExtras | null {
  const out: LegacyExtras = {};
  for (const [key, column] of Object.entries(LEGACY_EXTRA_COLUMNS) as [LegacyExtraKey, string][]) {
    const value = row[column];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Order-independent equality (jsonb does not keep key order). */
export function sameLegacyExtras(a: LegacyExtras | null | undefined, b: LegacyExtras | null | undefined): boolean {
  const canon = (e: LegacyExtras | null | undefined) =>
    JSON.stringify(e == null ? null : (Object.keys(LEGACY_EXTRA_COLUMNS) as LegacyExtraKey[]).map((k) => e[k] ?? null));
  return canon(a) === canon(b);
}
