/**
 * Phase 6 exit (spec §9): about 20 query → expected-key pairs over a fictional corpus, top 5
 * hits in text and semantic mode, in a throwaway database (TEST_DATABASE_ADMIN_URL). Text mode
 * must find every expected key (Postgres full-text relevance is real). The semantic column
 * means something only with a real provider: with the stand-in it proves the plumbing only, and
 * the relevance check proper waits for Azure (Q70). EMBEDDINGS_PROVIDER=azure-openai (plus the
 * Azure settings) runs the same check against Azure.
 */
import { pathToFileURL } from "node:url";
import { createEmbeddingProvider, createGuardedEmbedder, embeddingsEnvSchema, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../apps/news-api/test/helpers";
import { runEmbeddingTick } from "../apps/news-api/src/embeddings/worker";
import { applyRelease } from "../apps/news-api/src/projections";
import { createSemanticSearch } from "../apps/news-api/src/search/semantic";
import { createSearchService } from "../apps/news-api/src/search/service";
import { QueryVectorCache } from "../apps/news-api/src/search/vector-cache";

/** Fictional releases: [key, headline, body]. */
export const SPOT_CORPUS: [string, string, string][] = [
  ["SPOT-01", "Wildfire crews contain blaze near Lytton Creek", "Firefighters contained the wildfire after three days, and evacuation orders were lifted."],
  ["SPOT-02", "New ferry terminal opens at Horseshoe Bay", "The terminal adds two berths and a covered walkway for foot passengers."],
  ["SPOT-03", "Salmon habitat restoration funding announced", "Grants will restore spawning streams along the Fraser River."],
  ["SPOT-04", "Rural clinics extend weekend hours", "Patients in small communities can see a nurse practitioner on Saturdays."],
  ["SPOT-05", "Province expands school breakfast program", "Students in 200 more schools will get a free breakfast every morning."],
  ["SPOT-06", "Highway 99 rockfall repairs complete", "Crews stabilized the slope and reopened both lanes."],
  ["SPOT-07", "Tenant protections strengthened for renters", "Landlords must give more notice before ending a tenancy."],
  ["SPOT-08", "Child care fees reduced for families", "Parents will pay less for licensed child care spaces from January."],
  ["SPOT-09", "Drought response plan for farmers", "Water restrictions come with irrigation support for ranchers and growers."],
  ["SPOT-10", "Transit pass for seniors extended", "Seniors can ride buses for free during off-peak hours."],
  ["SPOT-11", "Heat warning issued for the Interior", "Cooling centres open as temperatures reach 40 degrees."],
  ["SPOT-12", "Apprenticeship grants for skilled trades", "Electricians and welders can apply for training grants."],
  ["SPOT-13", "Caribou recovery partnership signed", "First Nations and the province will protect caribou herds together."],
  ["SPOT-14", "Flood mitigation work begins in Abbotsford", "New dikes and pump stations will protect farmland."],
  ["SPOT-15", "Mental health supports for students", "Counsellors will be available at every post-secondary campus."],
  ["SPOT-16", "Electric vehicle rebates increased", "Drivers buying an electric car can get a larger rebate."],
  ["SPOT-17", "Forest deferrals extended", "Logging stays paused in ancient forest stands."],
  ["SPOT-18", "Minimum wage rises on June 1", "Workers earning the minimum wage will get a raise."],
  ["SPOT-19", "Wildlife crossing built over Highway 3", "An overpass will help elk and bighorn sheep cross safely."],
  ["SPOT-20", "Housing project for Indigenous elders", "The building has 40 affordable homes near the friendship centre."],
];

/** [query, expected key]: every query's words appear in its expected release. */
export const SPOT_QUERIES: [string, string][] = [
  ["wildfire evacuation", "SPOT-01"],
  ["ferry terminal", "SPOT-02"],
  ["salmon spawning", "SPOT-03"],
  ["nurse practitioner", "SPOT-04"],
  ["school breakfast", "SPOT-05"],
  ["rockfall", "SPOT-06"],
  ["renters landlords", "SPOT-07"],
  ["child care fees", "SPOT-08"],
  ["drought irrigation", "SPOT-09"],
  ["seniors transit", "SPOT-10"],
  ["cooling centres", "SPOT-11"],
  ["apprenticeship welders", "SPOT-12"],
  ["caribou herds", "SPOT-13"],
  ["dikes pump", "SPOT-14"],
  ["counsellors campus", "SPOT-15"],
  ["electric rebate", "SPOT-16"],
  ["ancient forest", "SPOT-17"],
  ["minimum wage", "SPOT-18"],
  ["elk overpass", "SPOT-19"],
  ["affordable homes elders", "SPOT-20"],
];

const release = ([key, headline, body]: [string, string, string], i: number): ReleaseRecord => ({
  ...sampleRelease,
  key,
  reference: null,
  summary: null,
  keywords: null,
  location: null,
  publishDate: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00-07:00`,
  leadMinistryKey: "health",
  ministryKeys: ["health"],
  sectorKeys: [],
  documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: `<p>${body}</p>` }],
});

export interface SpotCheckResult {
  providerId: string;
  textHits: number;
  semanticHits: number;
  semanticReached: boolean;
  ok: boolean;
}

export async function runSpotCheck(o: { provider?: EmbeddingProvider | null; log?: (line: string) => void } = {}): Promise<SpotCheckResult> {
  const log = o.log ?? console.log;
  const provider = o.provider ?? createEmbeddingProvider(embeddingsEnvSchema.parse(process.env)) ?? standInProvider();
  const threshold = Number(process.env.SEARCH_SEMANTIC_THRESHOLD ?? 0.6);
  const tdb = await createNewsTestDb();
  try {
    for (const [i, r] of SPOT_CORPUS.entries()) await tdb.db.transaction((tx) => applyRelease(tx, release(r, i), { notify: false }));
    const embedder = createGuardedEmbedder({ provider });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
    const common = { db: tdb.db, timeZone: "America/Vancouver", language: "english" as const, defaultLanguageId: 4105, publicSiteUrl: "https://news.example.test" };
    const text = createSearchService(common);
    const semantic = createSearchService({
      ...common,
      semantic: createSemanticSearch({ db: tdb.db, embedder, cache: new QueryVectorCache(), language: "english", defaultLanguageId: 4105, threshold }),
    });

    log(`Search spot-check: ${SPOT_QUERIES.length} queries over ${SPOT_CORPUS.length} fictional releases. Provider: ${provider.id}.`);
    if (provider.id === "stand-in") {
      log("NOTE: the stand-in provider proves only the plumbing (embed, store, query, order); its semantic ranks say nothing about relevance. The relevance check proper waits for an Azure OpenAI deployment (Q70).");
    }
    let textHits = 0;
    let semanticHits = 0;
    let semanticReached = false;
    for (const [q, expected] of SPOT_QUERIES) {
      const t = (await text.search({ q, page: 1 })).results.slice(0, 5).map((r) => r.key);
      const sRes = await semantic.search({ q, page: 1 });
      const s = sRes.results.slice(0, 5).map((r) => r.key);
      if (sRes.mode === "semantic") semanticReached = true;
      const tRank = t.indexOf(expected) + 1;
      const sRank = s.indexOf(expected) + 1;
      if (tRank > 0) textHits++;
      if (sRank > 0) semanticHits++;
      log(`${tRank > 0 ? "ok  " : "MISS"} "${q}" → ${expected}: text #${tRank || "-"} [${t.join(", ")}]; ${sRes.mode} #${sRank || "-"} [${s.join(", ")}]`);
    }
    const ok = textHits === SPOT_QUERIES.length && semanticReached;
    log(`Text mode: ${textHits}/${SPOT_QUERIES.length} in the top 5. Semantic mode (${provider.id}): ${semanticHits}/${SPOT_QUERIES.length} in the top 5${provider.id === "stand-in" ? " (plumbing only, Q70)" : ""}.`);
    if (!semanticReached) log("FAIL: the semantic branch never answered (provider, pgvector or the vector query).");
    return { providerId: provider.id, textHits, semanticHits, semanticReached, ok };
  } finally {
    await tdb.drop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSpotCheck().then(
    (r) => {
      if (!r.ok) process.exitCode = 1;
    },
    (e: unknown) => {
      console.error("search spot-check: failed to run", e);
      process.exitCode = 1;
    },
  );
}
