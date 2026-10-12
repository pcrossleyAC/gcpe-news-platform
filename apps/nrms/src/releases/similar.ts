import { inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { LANG_EN, type ReleaseView } from "@gcpe/nrms-contract";
import type { NewsApiSimilarClient } from "../clients";
import { organizations } from "../db/schema";
import { htmlToText } from "../text/html-to-text";

export const SIMILAR_TEXT_MAX_CHARS = 8000;
export const SIMILAR_TERMS_MAX_CHARS = 1000;

const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cap = (s: string, n: number) => {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join("");
};
const english = <T extends { languageId: number }>(langs: T[]): T | undefined => langs.find((l) => l.languageId === LANG_EN) ?? langs[0];

/** Spec §7's text: headline, summary, keywords and the body as plain text, capped at 8,000
 * characters; `terms` (headline and keywords) drives text-mode matching. From the saved release. */
export function similarSource(view: ReleaseView): { text: string; terms: string } {
  const docs = [...view.documents].sort((a, b) => a.sortIndex - b.sortIndex);
  const headline = oneLine(english(docs[0]?.languages ?? [])?.headline);
  const summary = oneLine(english(view.languages)?.summary);
  const keywords = oneLine(view.keywords);
  const bodies = docs.map((d) => oneLine(htmlToText(english(d.languages)?.bodyHtml ?? "")));
  const join = (parts: string[]) => parts.filter((p) => p !== "").join(" ");
  return { text: cap(join([headline, summary, keywords, ...bodies]), SIMILAR_TEXT_MAX_CHARS), terms: cap(join([headline, keywords]), SIMILAR_TERMS_MAX_CHARS) };
}

export interface SimilarDeps {
  client: NewsApiSimilarClient;
  /** NRMS's own tenant features.staffAi: off means NRMS never asks for AI matching. */
  staffAi: boolean;
}

export interface SimilarRelease {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistry: string | null;
  url: string;
  match: "ai" | "text";
}

export type SimilarOutcome = { kind: "found"; found: { mode: "ai" | "text"; results: SimilarRelease[] } } | { kind: "empty" } | { kind: "failed" };

/** Asks the News API for published releases like this one. Writes nothing; a failure logs a safe
 * label only, never the draft. */
export async function findSimilar(db: Db, view: ReleaseView, deps: SimilarDeps): Promise<SimilarOutcome> {
  const { text, terms } = similarSource(view);
  if (text === "") return { kind: "empty" };
  let found;
  try {
    found = await deps.client.similar({ text, terms, mode: deps.staffAi ? "ai" : "text", ...(view.key ? { excludeKey: view.key } : {}) });
  } catch (e) {
    console.error(`[nrms] similar releases failed ${safeErrorLabel(e)}`);
    return { kind: "failed" };
  }
  const keys = [...new Set(found.results.map((r) => r.leadMinistryKey?.toLowerCase()).filter((k): k is string => !!k))];
  const rows = keys.length ? await db.select({ key: organizations.key, name: organizations.displayName }).from(organizations).where(inArray(organizations.key, keys)) : [];
  const names = new Map(rows.map((r) => [r.key.toLowerCase(), r.name]));
  return {
    kind: "found",
    found: {
      mode: found.mode,
      results: found.results.map((r) => ({
        key: r.key,
        headline: r.headline,
        publishDate: r.publishDate,
        leadMinistry: r.leadMinistryKey ? (names.get(r.leadMinistryKey.toLowerCase()) ?? null) : null,
        url: r.url,
        match: r.match,
      })),
    },
  };
}
