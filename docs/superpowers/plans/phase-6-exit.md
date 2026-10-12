# Phase 6 exit (spec addendum §9, §10)

Recorded at the end of 6e on `feat/phase-6de`. Each check names the command that ran it.

| Exit check | Result | How |
|---|---|---|
| axe-core, every public page type (home, release, ministries, ministry, sector, theme, tag, archive index, monthly archive, search, 404) | Passed: zero violations (WCAG 2.0–2.2 A/AA and best-practice tags) | `npm run site:quality` on the fictional fixture site |
| axe-core, the staff release editor's "Similar published releases" panel | Passed: zero violations | `tests/e2e/staff-similar.spec.ts` |
| Lighthouse (production-config fixture build): accessibility ≥ 95, performance ≥ 90, best practices ≥ 90, SEO ≥ 90 | Passed locally; scores below | `npm run site:quality`; CI job `site-quality` (not yet a required check, Q87) |
| Search spot-check, text mode (20 queries, top 5) | Passed: 20/20 | `npm run search:spot-check` |
| Search spot-check, semantic relevance | **Waits on Q70** (Azure OpenAI). With the stand-in provider the run proves only the plumbing: embedding, storage, the vector query and the two-group order. | the same script with `EMBEDDINGS_PROVIDER=azure-openai` |
| Semantic search on a shared test environment | **Waits on Q80**: boxs.ca's Postgres has no pgvector, so it always answers in text mode. Semantic mode is verified locally and in CI only. | `/stack/health` → `newsApiSearch` |
| Staff-AI flag enforcement (News API flag off → zero provider calls for `mode: "ai"`, NRMS flag on) | Passed | `apps/news-api/src/search/similar-flag.test.ts` |
| Staff AI in production | **Off until the PIA approves it (Q71)**. The runbook's "Turning the flags on, and the PIA gate for staff AI" is the procedure. | — |

## Lighthouse scores (fixture site)

```
lighthouse /: performance 100, accessibility 100, best-practices 96, seo 92
lighthouse /releases/2026HLTH0001-000001/: performance 100, accessibility 100, best-practices 96, seo 100
lighthouse /ministries/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /ministries/health/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /sectors/economy/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /themes/housing/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /tags/covid-19/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /archive/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /archive/2026/10/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /search/: performance 100, accessibility 100, best-practices 100, seo 92
lighthouse /404.html: performance 100, accessibility 100, best-practices 100, seo 92
```

## Search spot-check summary

```
Search spot-check: 20 queries over 20 fictional releases. Provider: stand-in.
NOTE: the stand-in provider proves only the plumbing (embed, store, query, order); its semantic ranks say nothing about relevance. The relevance check proper waits for an Azure OpenAI deployment (Q70).
Text mode: 20/20 in the top 5. Semantic mode (stand-in): 20/20 in the top 5 (plumbing only, Q70).
```

## Open questions this phase leaves

Q70 (Azure), Q71 (PIA), Q80 (pgvector test environment), Q86 (saved vs unsaved draft), Q87 (CI check), Q88 (embedding published posts under staff AI).
