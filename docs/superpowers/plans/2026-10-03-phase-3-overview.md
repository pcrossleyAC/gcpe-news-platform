# Phase 3 (NRMS parity) — plan overview

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md`. The spec covers six largely separate subsystems, so Phase 3 is delivered as six sub-plans. Each one produces working, tested software on its own and is executed and reviewed before the next starts. They run in this order because each later one consumes only verified outputs of earlier ones.

| # | Sub-plan | Spec sections | Depends on | Produces |
|---|---|---|---|---|
| 3a | Staff identity: Core users, roles, session cookie | §2 | — | `users`/`role_grants` in Core; `/core/auth/login|logout|session`; cookie accepted by every app's API; `actorOf(req)`; test-user seeding |
| 3b | NRMS releases: data model, workflow, renditions | §3, §4, §5 (renditions), §9 | 3a | Normalised release tables; approve/schedule/publish/correct/unpublish/delete; numbering; slugs; sanitiser; search API; text/PDF renditions; "email me a copy"; NoD count endpoint |
| 3c | Media and Flickr | §7, §6.7 storage | 3b | `packages/storage`; uploads; page images; Flickr client + fake + publish job; oEmbed embeds |
| 3d | Website section API | §6 | 3b, 3c | Carousel, emergency pins, live feed, Blue Bridge, featured page, resource links, files; TEST banner/noindex off production |
| 3e | NRMS legacy importer | §8 | 3b, 3c, 3d | `nrms:import`, `nrms:release-holds`, `nrms:replay-to-news-api`, report |
| 3f | Staff web app + acceptance | §5, §9 | all | `apps/staff-web` at `/hub/`; Playwright acceptance list 1–16 |

Each sub-plan is written just before it runs, from the approved spec and the code as it then stands (so its code blocks match real interfaces rather than guesses about code that doesn't exist yet).
